"""Optional desktop helper. Receives exactly one approved action on stdin."""
import sys, json, io, base64, os

def main():
    import pyautogui as gui
    gui.FAILSAFE = True  # Move pointer to a screen corner to interrupt.
    gui.PAUSE = 0.3
    args = json.loads(sys.stdin.read(20000))
    action = args.get('action')
    if action == 'screenshot':
        if sys.platform.startswith('linux'):
            if os.environ.get('XDG_SESSION_TYPE') == 'wayland':
                raise ValueError('Desktop control requires an X11 session on Linux')
            from PIL import ImageGrab
            shot = ImageGrab.grab(xdisplay=os.environ.get('DISPLAY', ''))
        else:
            shot = gui.screenshot()
        # macOS Retina images use physical pixels; mouse coordinates use logical pixels.
        logical = gui.size()
        if shot.size != tuple(logical):
            shot = shot.resize(tuple(logical))
        # Return dimensions matching the mouse coordinate system.
        buff = io.BytesIO()
        shot.save(buff, format='PNG')
        if len(buff.getvalue()) > 7 * 1024 * 1024:
            raise ValueError('Screenshot exceeds 7 MB. Reduce display resolution and try again.')
        return {'info': {'width': shot.width, 'height': shot.height, 'display': 'primary', 'note': 'Coordinates match this screenshot; inspect before clicking.'}, 'image': 'data:image/png;base64,' + base64.b64encode(buff.getvalue()).decode()}
    if action == 'click':
        x, y = int(args['x']), int(args['y'])
        if not gui.onScreen(x, y): raise ValueError('Coordinates outside primary screen')
        gui.click(x, y)
    elif action == 'type':
        text = args.get('text', '')
        if not isinstance(text, str) or len(text) > 4000 or not text.isascii(): raise ValueError('Typing supports up to 4000 ASCII characters. Use file tools for Unicode content.')
        gui.write(text, interval=0.02)
    elif action == 'press':
        key = args.get('text')
        if key not in gui.KEYBOARD_KEYS: raise ValueError('Unsupported key')
        gui.press(key)
    elif action == 'hotkey':
        keys = args.get('keys', [])
        if not isinstance(keys, list) or not 1 <= len(keys) <= 4 or any(k not in gui.KEYBOARD_KEYS for k in keys): raise ValueError('Invalid hotkey')
        gui.hotkey(*keys)
    elif action == 'scroll':
        amount = args.get('amount', 0)
        if not isinstance(amount, int) or abs(amount) > 30: raise ValueError('Scroll range is -30 to 30')
        gui.scroll(amount)
    else: raise ValueError('Unknown desktop action')
    return {'info': {'completed': action}}

try:
    print(json.dumps(main()))
except Exception as exc:
    print(json.dumps({'error': str(exc) + ' (Desktop control requires Python, PyAutoGUI, Pillow, and OS accessibility/screen permissions.)'}))
