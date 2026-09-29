"""8-hour build budget timer. Run: python3 timer.py [status|budget]."""
import json, sys, time
from pathlib import Path
STATE = Path(__file__).parent / ".timer.json"
BUDGET_H = 8
def load():
    if STATE.exists(): return json.loads(STATE.read_text())
    s = {"start": time.time(), "budget_h": BUDGET_H}
    STATE.write_text(json.dumps(s)); return s
s = load()
el = (time.time() - s["start"]) / 3600
print(f"elapsed={el:.2f}h remaining={s['budget_h']-el:.2f}h budget={s['budget_h']}h")
