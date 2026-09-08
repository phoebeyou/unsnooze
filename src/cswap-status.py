"""Read only public switch metadata under claude-swap 0.26's actual locks.

Never opens credentials, invokes the switcher, or creates/modifies its files.
The JSON reply contains no account email, token, or account identifier.
"""
import fcntl
import json
import sys
from contextlib import ExitStack
from pathlib import Path


def snapshot(root):
    with ExitStack() as stack:
        # Same order as AutoSwitchEngine._attempt_switch; never block.
        for name in ('.autoswitch_state.lock', '.lock'):
            handle = stack.enter_context((root / name).open('r'))
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
        sequence_path = root / 'sequence.json'
        state_path = root / 'autoswitch_state.json'
        sequence = json.loads(sequence_path.read_text())
        state = json.loads(state_path.read_text())
        if not isinstance(sequence, dict) or not isinstance(state, dict):
            raise ValueError('unsupported metadata')
        active = sequence.get('activeAccountNumber')
        accounts = sequence.get('accounts')
        if not isinstance(accounts, dict) or str(active) not in accounts:
            raise ValueError('unknown active slot')
        if state.get('schemaVersion') != 1:
            raise ValueError('unsupported switch state')
        stamp = state.get('lastSwitchAt')
        confirmed = (isinstance(stamp, (int, float)) and not isinstance(stamp, bool)
                     and stamp > 0 and str(state.get('lastSwitchTo')) == str(active)
                     and state.get('lastSwitchFrom') is not None
                     and str(state.get('lastSwitchFrom')) != str(active))
        return {
            'available': True,
            'changedAt': sequence_path.stat().st_mtime * 1000,
            'switchedAt': stamp * 1000 if confirmed else None,
        }


if __name__ == '__main__':
    try:
        result = snapshot(Path(sys.argv[1]))
    except BlockingIOError:
        result = {'available': False, 'reason': 'account switch in progress'}
    except (OSError, ValueError, TypeError, IndexError):
        result = {'available': False, 'reason': 'account-switch metadata unavailable'}
    print(json.dumps(result, allow_nan=False))
