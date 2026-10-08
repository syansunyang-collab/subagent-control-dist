"""Check capture provenance using two owned Win32 windows and an explicit helper."""
import argparse
import ctypes
from ctypes import wintypes as W
import json
import os
from pathlib import Path
import threading
import time
import uuid

from native_client import Bridge

parser = argparse.ArgumentParser()
parser.add_argument('--helper', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
u = ctypes.WinDLL('user32', use_last_error=True)
k = ctypes.WinDLL('kernel32', use_last_error=True)
g = ctypes.WinDLL('gdi32', use_last_error=True)
LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, W.HWND, W.UINT, W.WPARAM, W.LPARAM)


class WNDCLASS(ctypes.Structure):
    _fields_ = [('style', W.UINT), ('lpfnWndProc', WNDPROC), ('cbClsExtra', ctypes.c_int),
                ('cbWndExtra', ctypes.c_int), ('hInstance', W.HINSTANCE), ('hIcon', W.HICON),
                ('hCursor', W.HANDLE), ('hbrBackground', W.HBRUSH), ('lpszMenuName', W.LPCWSTR),
                ('lpszClassName', W.LPCWSTR)]


k.GetModuleHandleW.argtypes = [W.LPCWSTR]
k.GetModuleHandleW.restype = W.HINSTANCE
u.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASS)]
u.RegisterClassW.restype = W.ATOM
u.CreateWindowExW.argtypes = [W.DWORD, W.LPCWSTR, W.LPCWSTR, W.DWORD, ctypes.c_int,
                            ctypes.c_int, ctypes.c_int, ctypes.c_int, W.HWND, W.HMENU,
                            W.HINSTANCE, ctypes.c_void_p]
u.CreateWindowExW.restype = W.HWND
u.DefWindowProcW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
u.DefWindowProcW.restype = LRESULT
u.GetForegroundWindow.restype = W.HWND
u.SetForegroundWindow.argtypes = [W.HWND]
u.SetWindowPos.argtypes = [W.HWND, W.HWND, ctypes.c_int, ctypes.c_int,
                           ctypes.c_int, ctypes.c_int, W.UINT]
u.GetWindowRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
u.WindowFromPoint.argtypes = [W.POINT]
u.WindowFromPoint.restype = W.HWND
u.GetAncestor.argtypes = [W.HWND, W.UINT]
u.GetAncestor.restype = W.HWND
u.GetCursorPos.argtypes = [ctypes.POINTER(W.POINT)]
u.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
u.mouse_event.argtypes = [W.DWORD, W.DWORD, W.DWORD, W.DWORD, ctypes.c_size_t]
u.ShowWindow.argtypes = [W.HWND, ctypes.c_int]
u.UpdateWindow.argtypes = [W.HWND]
u.DestroyWindow.argtypes = [W.HWND]
u.IsWindow.argtypes = [W.HWND]
u.PostMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
u.UnregisterClassW.argtypes = [W.LPCWSTR, W.HINSTANCE]
u.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
g.CreateSolidBrush.argtypes = [W.DWORD]
g.CreateSolidBrush.restype = W.HBRUSH
g.DeleteObject.argtypes = [W.HANDLE]
u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
previous = u.GetForegroundWindow()
previous_cursor = W.POINT()
u.GetCursorPos(ctypes.byref(previous_cursor))
clicked_point = None
handles = []
ready = threading.Event()
errors = []
class_name = 'PiCaptureFixture-' + uuid.uuid4().hex
running = True


@WNDPROC
def window_proc(hwnd, message, wp, lp):
    if message in (0x0317, 0x0318):  # WM_PRINT / WM_PRINTCLIENT: deliberately no pixels.
        return 0
    return u.DefWindowProcW(hwnd, message, wp, lp)


def windows():
    instance = k.GetModuleHandleW(None)
    brush = g.CreateSolidBrush(0x00000000)
    registered = False
    try:
        u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        klass = WNDCLASS(0, window_proc, 0, 0, instance, None, None, brush, None, class_name)
        if not u.RegisterClassW(ctypes.byref(klass)):
            raise ctypes.WinError(ctypes.get_last_error())
        registered = True
        for title in ('background-print-blank', 'foreground-cover'):
            style = 0x80000000 if title == 'background-print-blank' else 0x00CF0000
            hwnd = u.CreateWindowExW(0, class_name, title, style, 80, 80, 480, 320,
                                     None, None, instance, None)
            if not hwnd:
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(hwnd)
            u.ShowWindow(hwnd, 5)
            u.UpdateWindow(hwnd)
        u.SetForegroundWindow(handles[1])
        ready.set()
        message = W.MSG()
        while running:
            while u.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
                u.TranslateMessage(ctypes.byref(message))
                u.DispatchMessageW(ctypes.byref(message))
            time.sleep(0.005)
    except Exception as error:
        errors.append(error)
        ready.set()
    finally:
        for hwnd in reversed(handles):
            if u.IsWindow(hwnd):
                u.DestroyWindow(hwnd)
        if registered:
            u.UnregisterClassW(class_name, instance)
        g.DeleteObject(brush)


thread = threading.Thread(target=windows)
thread.start()
bridge = None
try:
    assert ready.wait(10), 'owned fixture did not start'
    if errors:
        raise errors[0]
    deadline = time.monotonic() + 5
    while u.GetForegroundWindow() != handles[1] and time.monotonic() < deadline:
        u.SetForegroundWindow(handles[1])
        time.sleep(0.05)
    if u.GetForegroundWindow() != handles[1]:
        u.SetWindowPos(handles[1], ctypes.c_void_p(-1), 80, 80, 480, 320, 0)
        rect = W.RECT()
        assert u.GetWindowRect(handles[1], ctypes.byref(rect))
        point = W.POINT(rect.left + 120, rect.top + 16)
        assert u.GetAncestor(u.WindowFromPoint(point), 2) == handles[1], 'caption is not owned'
        clicked_point = point
        u.SetCursorPos(point.x, point.y)
        u.mouse_event(0x0002, 0, 0, 0, 0)
        u.mouse_event(0x0004, 0, 0, 0, 0)
        deadline = time.monotonic() + 5
        while u.GetForegroundWindow() != handles[1] and time.monotonic() < deadline:
            time.sleep(0.05)
    assert u.GetForegroundWindow() == handles[1], 'owned cover window did not gain foreground'
    bridge = Bridge(args.helper, args.output)
    background = bridge.call('look', {'windowId': handles[0], 'pid': os.getpid(),
                                     'includeImage': True, 'includeElements': False, 'readText': 'never'})
    assert background['ok'] is False and background['error']['code'] == 'capture_failed', {
        'ok': background['ok'], 'error': background.get('error'),
        'captureMethod': background.get('result', {}).get('image', {}).get('captureMethod'),
    }
    assert u.GetForegroundWindow() == handles[1], 'background observation changed foreground'
    foreground = bridge.call('look', {'windowId': handles[1], 'pid': os.getpid(),
                                     'includeImage': True, 'includeElements': False, 'readText': 'never'})
    assert foreground['ok'], foreground
    assert foreground['result']['image']['captureMethod'] == 'screen-region', foreground
    assert foreground['result']['image']['jpegBase64'], foreground
    result = {'helper': str(args.helper.resolve()), 'backgroundHwnd': handles[0],
              'foregroundHwnd': handles[1], 'backgroundError': background['error'],
              'foregroundCaptureMethod': foreground['result']['image']['captureMethod'], 'passed': True}
    (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
finally:
    if bridge:
        bridge.close()
    restore_foreground = u.GetForegroundWindow() in handles
    running = False
    thread.join(timeout=10)
    assert not thread.is_alive(), 'owned window thread did not exit'
    assert not any(u.IsWindow(hwnd) for hwnd in handles), 'owned windows were not closed'
    (args.output / 'cleanup.json').write_text(json.dumps({
        'windowsClosed': True, 'threadExited': True,
        'helperExitCode': bridge.process.poll() if bridge else None,
    }, indent=2) + '\n', encoding='utf-8')
    if restore_foreground and previous and u.IsWindow(previous):
        u.SetForegroundWindow(previous)
    current_cursor = W.POINT()
    u.GetCursorPos(ctypes.byref(current_cursor))
    if clicked_point and (current_cursor.x, current_cursor.y) == (clicked_point.x, clicked_point.y):
        u.SetCursorPos(previous_cursor.x, previous_cursor.y)
