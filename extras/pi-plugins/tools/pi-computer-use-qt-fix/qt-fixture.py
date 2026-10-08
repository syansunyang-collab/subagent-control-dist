"""Disposable Qt5 UI; no camera, serial, USB or production configuration access."""
import argparse
import json
import os
import sys
import traceback
from pathlib import Path
from PyQt5 import QtCore, QtWidgets

parser = argparse.ArgumentParser()
parser.add_argument('--state-dir', type=Path, required=True)
parser.add_argument('--nonce', required=True)
args = parser.parse_args()
args.state_dir.mkdir(parents=True, exist_ok=True)
QtWidgets.QApplication.setAttribute(QtCore.Qt.AA_EnableHighDpiScaling)
app = QtWidgets.QApplication([])

def report_exception(kind, error, trace):
    (args.state_dir / 'fixture-error.log').write_text(
        ''.join(traceback.format_exception(kind, error, trace)), encoding='utf-8')
    app.exit(3)

sys.excepthook = report_exception
window = QtWidgets.QWidget()
window.setWindowTitle('Pi UIA Candidate Fixture')
window.resize(480, 660)
window.move(40, 40)
layout = QtWidgets.QVBoxLayout(window)
status = QtWidgets.QLabel('隔离测试窗口：不连接相机或设备')
layout.addWidget(status)
counts = {'A': 0, 'same_left': 0, 'same_right': 0, 'B': 0, 'canvas': 0}
buttons = {}
last_command = None


def save_state():
    state = {'pid': os.getpid(), 'parentPid': os.getppid(), 'nonce': args.nonce,
             'hwnd': int(window.winId()), 'counts': counts,
             'texts': [edit.text() for edit in edits], 'combo': combo.currentText(),
             'popupRow': combo.view().currentIndex().row(),
             'lastCommand': last_command, 'overlayVisible': overlay.isVisible(),
             'focused': app.focusWidget().accessibleName() if app.focusWidget() else None,
             'removedB': buttons.get('B') is None}
    with (args.state_dir / 'state.jsonl').open('a', encoding='utf-8') as output:
        output.write(json.dumps(state, ensure_ascii=False) + '\n')


def clicked(key):
    counts[key] += 1
    status.setText('{}: {}'.format(key, counts[key]))
    save_state()


for key, title in [('A', '按钮A'), ('same_left', '同名按钮'), ('same_right', '同名按钮'), ('B', '按钮B')]:
    button = QtWidgets.QPushButton(title)
    button.setMinimumHeight(42)
    button.clicked.connect(lambda _checked=False, key=key: clicked(key))
    layout.addWidget(button)
    buttons[key] = button
edits = []
for index in range(2):
    edit = QtWidgets.QLineEdit()
    edit.setAccessibleName('输入框{}'.format(index + 1))
    edit.setMinimumHeight(35)
    edit.textChanged.connect(lambda _text: save_state())
    layout.addWidget(edit)
    edits.append(edit)
combo = QtWidgets.QComboBox()
combo.setAccessibleName('格式测试下拉框')
combo.addItems(['YUV', 'RAW16+YUV', 'TempMatrix+YUV'])
combo.setMinimumHeight(38)
combo.currentTextChanged.connect(lambda _text: save_state())
layout.addWidget(combo)


class Canvas(QtWidgets.QLabel):
    def mousePressEvent(self, event):
        clicked('canvas')
        super().mousePressEvent(event)


canvas = Canvas('物理点击画布')
canvas.setAccessibleName('物理点击画布')
canvas.setMinimumHeight(85)
canvas.setStyleSheet('background:#d7e8ff; border:2px solid #4278bf;')
layout.addWidget(canvas)
overlay = QtWidgets.QWidget(None, QtCore.Qt.Tool | QtCore.Qt.FramelessWindowHint |
                           QtCore.Qt.WindowStaysOnTopHint | QtCore.Qt.WindowDoesNotAcceptFocus)
overlay.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
overlay.setWindowTitle('Pi UIA Fixture Occluder')
overlay.setStyleSheet('background:#ed9090;')
QtWidgets.QVBoxLayout(overlay).addWidget(QtWidgets.QLabel('遮挡反例'))


def commands():
    global last_command
    for command_path in sorted(args.state_dir.glob('command-*.json')):
        command = json.loads(command_path.read_text(encoding='utf-8'))
        operation = command['operation']
        if operation == 'show_overlay':
            overlay.setGeometry(QtCore.QRect(canvas.mapToGlobal(QtCore.QPoint(0, 0)), canvas.size()))
            overlay.show()
            overlay.raise_()
        elif operation == 'hide_overlay':
            overlay.hide()
        elif operation == 'remove_b':
            button = buttons.pop('B')
            layout.removeWidget(button)
            button.hide()
            button.deleteLater()
            buttons['B'] = None
        elif operation == 'open_combo':
            combo.showPopup()
        elif operation == 'close_combo':
            combo.hidePopup()
        elif operation == 'quit':
            overlay.close()
            window.close()
            app.quit()
        else:
            raise ValueError(operation)
        last_command = command_path.name
        command_path.unlink()
        save_state()


class InputTrace(QtCore.QObject):
    def eventFilter(self, obj, event):
        if event.type() in (QtCore.QEvent.MouseButtonPress, QtCore.QEvent.KeyPress):
            record = {'class': obj.metaObject().className(),
                      'name': obj.accessibleName() if hasattr(obj, 'accessibleName') else None,
                      'event': int(event.type())}
            if event.type() == QtCore.QEvent.MouseButtonPress:
                record['global'] = [event.globalPos().x(), event.globalPos().y()]
                record['local'] = [event.pos().x(), event.pos().y()]
            else:
                record['text'] = event.text()
                record['key'] = event.key()
                record['modifiers'] = int(event.modifiers())
            with (args.state_dir / 'input-events.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps(record, ensure_ascii=False) + '\n')
        return False

trace = InputTrace(app)
app.installEventFilter(trace)
app.focusChanged.connect(lambda _old, _new: save_state())
combo.view().selectionModel().currentChanged.connect(lambda _current, _old: save_state())
timer = QtCore.QTimer()
timer.timeout.connect(commands)
timer.start(25)
window.show()
app.processEvents()
save_state()
sys.exit(app.exec_())
