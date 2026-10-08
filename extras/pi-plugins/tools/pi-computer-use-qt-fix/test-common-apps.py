"""候选 helper 的常用软件验收；图纸和文本均存入指定测试目录。"""
import argparse
import ctypes
import json
import subprocess
import time
import traceback
import uuid
from pathlib import Path
import pythoncom
import win32com.client.dynamic
from native_client import Bridge

parser = argparse.ArgumentParser()
parser.add_argument('--helper', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--software', nargs='+', choices=['AutoCAD 2027', '记事本', '资源管理器'])
args = parser.parse_args()
args.output = args.output.resolve()
args.output.mkdir(parents=True, exist_ok=True)
nonce = uuid.uuid4().hex[:10]
user32 = ctypes.windll.user32
user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.GetAncestor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
user32.GetAncestor.restype = ctypes.c_void_p

class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]

class RECT(ctypes.Structure):
    _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long), ('right', ctypes.c_long), ('bottom', ctypes.c_long)]

user32.WindowFromPoint.argtypes = [POINT]
user32.WindowFromPoint.restype = ctypes.c_void_p
previous_foreground = user32.GetForegroundWindow()
bridge = Bridge(args.helper, args.output)
results = []


def ok(reply):
    if not reply.get('ok'):
        raise RuntimeError(json.dumps(reply, ensure_ascii=False))
    return reply['result']


def wait_until(test, seconds=20):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = test()
        if result:
            return result
        pythoncom.PumpWaitingMessages()
        time.sleep(.1)
    raise TimeoutError('等待软件状态超时')


def nodes(node):
    yield node
    for child in node.get('children', []):
        yield from nodes(child)


def roots():
    return ok(bridge.call('listRoots', {}))['roots']


def look(hwnd, include_image=False):
    return ok(bridge.call('look', {'windowId': int(hwnd), 'includeImage': include_image, 'readText': 'never'}))


def window_node(view):
    return next(node for node in nodes(view['outline']) if node.get('role') == 'window' and str(node.get('ref', '')).startswith('win:'))


def act(view, node, action, params=None):
    return ok(bridge.call('act', {'lookId': view['lookId'], 'target': {'ref': node['ref']},
        'action': action, 'params': params or {}, 'policy': 'foreground', 'deferRootDelta': True}))


def activate(hwnd):
    user32.ShowWindow(int(hwnd), 9)
    user32.SetForegroundWindow(int(hwnd))
    if user32.GetForegroundWindow() != int(hwnd):
        user32.SetWindowPos(int(hwnd), None, 0, 0, 0, 0, 0x13)
        rect = RECT()
        assert user32.GetWindowRect(int(hwnd), ctypes.byref(rect))
        point = POINT((rect.left + rect.right) // 2, rect.top + 10)
        assert user32.GetAncestor(user32.WindowFromPoint(point), 2) == int(hwnd), '测试窗口标题栏被遮挡'
        user32.SetCursorPos(point.x, point.y)
        user32.mouse_event(2, 0, 0, 0, 0)
        user32.mouse_event(4, 0, 0, 0, 0)
    wait_until(lambda: user32.GetForegroundWindow() == int(hwnd), 5)


def keys(view, *names):
    return act(view, window_node(view), 'keypress', {'keys': list(names)})


def root_named(fragment):
    return next((root for root in roots() if fragment in root.get('title', '') and root.get('kind') == 'window'), None)


def cad():
    pythoncom.CoInitialize()
    application = win32com.client.dynamic.Dispatch(
        pythoncom.GetActiveObject('AutoCAD.Application.26').QueryInterface(pythoncom.IID_IDispatch))
    wait_until(lambda: application.GetAcadState().IsQuiescent, 30)
    previous_doc = application.ActiveDocument if application.Documents.Count else None
    doc = application.Documents.Add('D:/Tools/Autodesk/AutoCAD 2027/UserdataCache/zh-cn/Template/acadiso.dwt')
    path = args.output / f'PiCandidate-{nonce}.dwg'
    doc.SaveAs(str(path))
    try:
        assert Path(doc.FullName) == path
        doc.Activate()
        activate(application.HWND)
        roots()
        view = look(application.HWND)
        (args.output / 'cad-outline.json').write_text(json.dumps(view, ensure_ascii=False, indent=2), encoding='utf-8')
        root = window_node(view)
        keys(view, 'ESC')
        keys(view, 'ESC')
        before = doc.ModelSpace.Count
        for expression in ['(setvar "USERR1" 123.456)', '(command "_.LINE" "0,0,0" "100,0,0" "")']:
            assert Path(application.ActiveDocument.FullName) == path
            act(view, root, 'typeText', {'text': expression})
            keys(view, 'ENTER')
            wait_until(lambda: application.GetAcadState().IsQuiescent, 20)
        wait_until(lambda: abs(float(doc.GetVariable('USERR1')) - 123.456) < .00001)
        wait_until(lambda: doc.ModelSpace.Count == before + 1)
        entity = doc.ModelSpace.Item(doc.ModelSpace.Count - 1)
        assert entity.ObjectName == 'AcDbLine', entity.ObjectName
        assert list(entity.StartPoint) == [0.0, 0.0, 0.0]
        assert list(entity.EndPoint) == [100.0, 0.0, 0.0]
        keys(view, 'CTRL', 'S')
        wait_until(lambda: bool(doc.Saved))
        evidence = {'version': application.Version, 'drawing': str(path), 'userr1': doc.GetVariable('USERR1'),
                    'entityCountBefore': before, 'entityCountAfter': doc.ModelSpace.Count,
                    'entity': entity.ObjectName, 'start': list(entity.StartPoint), 'end': list(entity.EndPoint)}
        menu = next((node for node in nodes(view['outline']) if node.get('role') in ('button', 'menuItem') and
                     ('应用程序菜单' in node.get('title', '') or 'Application Menu' in node.get('title', ''))), None)
        if menu:
            act(view, menu, 'press')
            opened = look(application.HWND)
            evidence['menuInvoked'] = menu.get('title')
            evidence['menuItemsAfter'] = [n.get('title') for n in nodes(opened['outline']) if n.get('role') == 'menuItem'][:20]
            keys(opened, 'ESC')
        else:
            evidence['menuInvoked'] = None
        return evidence
    finally:
        doc.Close(False)
        if previous_doc is not None:
            previous_doc.Activate()


def notepad():
    path = args.output / f'PiNotepad-{nonce}.txt'
    path.write_text('初始测试文本', encoding='utf-8')
    subprocess.Popen(['C:/Windows/System32/notepad.exe', str(path)])
    root = wait_until(lambda: root_named(path.stem), 25)
    hwnd = root['windowId']
    activate(hwnd)
    view = look(hwnd)
    (args.output / 'notepad-outline.json').write_text(json.dumps(view, ensure_ascii=False, indent=2), encoding='utf-8')
    editors = [node for node in nodes(view['outline']) if node.get('role') in ('edit', 'document', 'textArea') and node.get('isTextInput')]
    if not editors:
        editors = [node for node in nodes(view['outline']) if node.get('role') in ('edit', 'document', 'textArea')]
    assert len(editors) == 1, editors
    text = '候选助手验收 A-123，中文与英文输入均完成。'
    act(view, editors[0], 'setText', {'text': text})
    keys(view, 'CTRL', 'S')
    wait_until(lambda: path.read_text(encoding='utf-8-sig') == text)
    evidence = {'file': str(path), 'savedText': path.read_text(encoding='utf-8-sig'), 'editorRole': editors[0]['role']}
    keys(view, 'CTRL', 'W')
    return evidence


def explorer():
    folder = args.output / f'PiExplorer-{nonce}'
    folder.mkdir()
    sample = folder / f'CandidateSample-{nonce}.txt'
    sample.write_text('候选 helper 属性对话框验收', encoding='utf-8')
    subprocess.Popen(['C:/Windows/explorer.exe', '/n,', str(folder)])
    root = wait_until(lambda: root_named(folder.name), 25)
    hwnd = root['windowId']
    activate(hwnd)
    view = look(hwnd, include_image=True)
    (args.output / 'explorer-outline.json').write_text(json.dumps(view, ensure_ascii=False, indent=2), encoding='utf-8')
    candidates = [node for node in nodes(view['outline']) if node.get('title', '').startswith('CandidateSample') and node.get('role') in ('listItem', 'dataItem')]
    assert candidates, '测试文件未出现在控件树中'
    rect = candidates[0]['rect']
    ok(bridge.call('act', {'lookId': view['lookId'], 'target': {
        'x': rect['x'] + rect['w'] / 2, 'y': rect['y'] + rect['h'] / 2},
        'action': 'click', 'params': {}, 'policy': 'foreground', 'deferRootDelta': True}))
    keys(view, 'ALT', 'ENTER')
    dialog = wait_until(lambda: next((item for item in roots()
        if item.get('pid') == root['pid']
        and item.get('metadata', {}).get('className') == '#32770'
        and sample.stem in item.get('title', '')
        and ('属性' in item['title'] or 'Properties' in item['title'])), None), 15)
    assert dialog['windowId'] != hwnd, dialog
    properties = look(dialog['windowId'])
    (args.output / 'explorer-properties.json').write_text(json.dumps(properties, ensure_ascii=False, indent=2), encoding='utf-8')
    names = [node.get('title', '') for node in nodes(properties['outline'])]
    assert any('CandidateSample' in name for name in names), names
    assert any(name in ('确定', 'OK') for name in names), names
    assert any('大小' in name or 'Size' in name for name in names), names
    user32.PostMessageW(dialog['windowId'], 0x10, 0, 0)
    user32.PostMessageW(hwnd, 0x10, 0, 0)
    assert sample.read_text(encoding='utf-8') == '候选 helper 属性对话框验收'
    return {'folder': str(folder), 'propertiesTitle': dialog['title'], 'fields': names[:35]}


try:
    for name, operation in [('AutoCAD 2027', cad), ('记事本', notepad), ('资源管理器', explorer)]:
        if args.software and name not in args.software:
            continue
        try:
            result = {'software': name, 'passed': True, 'evidence': operation()}
        except Exception as error:
            result = {'software': name, 'passed': False, 'error': repr(error)}
            traceback.print_exc()
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
finally:
    bridge.close()
    if previous_foreground:
        user32.SetForegroundWindow(previous_foreground)
    (args.output / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
raise SystemExit(0 if all(result['passed'] for result in results) else 1)
