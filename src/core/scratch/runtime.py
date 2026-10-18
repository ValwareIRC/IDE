# Runs the scratchpad's Python cells. One of these processes lives as long as
# the notebook's session, so what one cell defines the next can use. Started by
# core/scratch/manager.ts with the project folder as its argument. Each line on
# stdin is one cell as JSON; replies go to the real stdout as lines that start
# with a marker, so anything else printed there (by a child process, say) is
# still shown as the cell's output.
import ast
import base64
import io
import json
import os
import sys
import traceback

MARK = "\x1ePRISM "
real = sys.__stdout__
os.environ.setdefault("MPLBACKEND", "Agg")  # charts are drawn to pictures, not windows


def send(obj):
    real.write(MARK + json.dumps(obj) + "\n")
    real.flush()


class Stream:
    def __init__(self, kind):
        self.kind = kind

    def write(self, s):
        if s:
            send({"type": "output", "output": {"kind": self.kind, "text": str(s)}})
        return len(s) if s else 0

    def flush(self):
        pass

    def isatty(self):
        return False


sys.stdout = Stream("text")
sys.stderr = Stream("stderr")
root = sys.argv[1]
os.chdir(root)
sys.path.insert(0, root)
env = {"__name__": "__main__"}


def cell_value(v):
    return v if isinstance(v, (str, int, float, bool)) or v is None else repr(v)


def describe(v):
    """How a cell's value is shown."""
    if v is None:
        return None
    try:
        if hasattr(v, "_repr_png_"):
            png = v._repr_png_()
            if png:
                return {"kind": "image", "src": "data:image/png;base64," + base64.b64encode(png).decode()}
        if hasattr(v, "_repr_html_"):
            html = v._repr_html_()
            if html:
                return {"kind": "html", "html": html}
    except Exception:
        pass
    if isinstance(v, (list, tuple)) and v and all(isinstance(r, dict) for r in v[:50]):
        cols = []
        for r in v[:500]:
            for k in r:
                if str(k) not in cols and len(cols) < 30:
                    cols.append(str(k))
        rows = []
        for r in v[:500]:
            named = {str(k): x for k, x in r.items()}
            rows.append([cell_value(named.get(c)) for c in cols])
        return {"kind": "table", "columns": cols, "rows": rows, "total": len(v)}
    if isinstance(v, (dict, list, tuple)):
        try:
            return {"kind": "json", "text": json.dumps(v, indent=2, default=repr)[:200000]}
        except Exception:
            pass
    if isinstance(v, str) and v.lstrip().startswith("<svg"):
        return {"kind": "html", "html": v}
    return {"kind": "text", "text": v if isinstance(v, str) else repr(v)}


def figures():
    """Any chart drawn with matplotlib in this cell becomes a picture."""
    plt = sys.modules.get("matplotlib.pyplot")
    if not plt:
        return
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", dpi=110, bbox_inches="tight")
        send({"type": "output", "output": {"kind": "image", "src": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}})
    plt.close("all")


send({"type": "ready", "version": sys.version.split()[0]})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    ok = True
    try:
        code = json.loads(line)["code"]
        tree = ast.parse(code, "<cell>", "exec")
        last = None
        # a cell that ends in an expression shows its value
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, "<cell>", "exec"), env)
        if last is not None:
            out = describe(eval(compile(last, "<cell>", "eval"), env))
            if out:
                send({"type": "output", "output": out})
        figures()
    except SystemExit:
        pass
    except BaseException:
        ok = False
        kind, value, tb = sys.exc_info()
        # of the traceback, only the lines inside the cell mean anything to its author
        frames = [f for f in traceback.extract_tb(tb) if f.filename == "<cell>"]
        text = "".join(traceback.format_list(frames)) + "".join(traceback.format_exception_only(kind, value))
        send({"type": "output", "output": {"kind": "error", "text": text}})
    send({"type": "done", "ok": ok})
