// A recorded key press as the AutoHotkey key name butler-keys.ahk binds.
// Null for keys that cannot be the talk key.
const KeyNames = (() => {
  const NAMED = {
    Pause: 'Pause', ScrollLock: 'ScrollLock', PrintScreen: 'PrintScreen', Insert: 'Insert', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right', CapsLock: 'CapsLock', NumLock: 'NumLock', Tab: 'Tab',
    Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', ContextMenu: 'AppsKey',
    ControlLeft: 'LCtrl', ControlRight: 'RCtrl', AltLeft: 'LAlt', AltRight: 'RAlt',
    ShiftLeft: 'LShift', ShiftRight: 'RShift', MetaLeft: 'LWin', MetaRight: 'RWin',
    NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSub', NumpadMultiply: 'NumpadMult',
    NumpadDivide: 'NumpadDiv', NumpadDecimal: 'NumpadDot', NumpadEnter: 'NumpadEnter',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  function fromCode(code) {
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return `Numpad${m[1]}`;
    if ((m = /^F(\d{1,2})$/.exec(code)) && +m[1] >= 1 && +m[1] <= 24) return code;
    return NAMED[code] || null;
  }
  return { fromCode };
})();
if (typeof module !== 'undefined') module.exports = KeyNames;
