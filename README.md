# Portfolio Analyzer Workspace

This branch keeps the two applications separate and preserves their independent launch workflows.

## Applications

- [`portfolio-analyzer/`](portfolio-analyzer/) - Portfolio Analyzer Pro, current stable version `v1.1.30.9`, including the versioned batch history and local market-data backend.
- [`side-tools/`](side-tools/) - Macro Data Lab, Fed Tracker, and Treasury Auction Tracker.

The Portfolio Analyzer was not replaced by Side Tools. Each application has its own README and startup commands inside its folder.

## Start Portfolio Analyzer

See [`portfolio-analyzer/README.md`](portfolio-analyzer/README.md). The current stable launchers are named `start-v1.1.30.9.*`.

## Start Side Tools

```powershell
cd .\side-tools
python .\serve.py --doctor
python .\serve.py
```

Then open `http://127.0.0.1:8017/` or the replacement port printed in the terminal.
