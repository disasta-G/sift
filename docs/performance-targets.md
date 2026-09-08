# Performance targets

The budgets `npm run bench` gates on. They are stated for a vault of **10 000
notes**, measured against the real engine rather than a stand-in, on a desktop
workstation.

| Target | Budget |
| --- | --- |
| Cold index of 10 000 notes | < 5 s |
| One search | < 100 ms |
| Index footprint | < 100 MB |

Two notes on how they are applied:

- **The search budget is not scaled.** A smaller vault only makes a search
  easier, so the same 100 ms holds at any note count.
- **The index budgets are scaled linearly** to whatever count the benchmark
  actually ran at. A run at 2 000 notes is therefore an indication, not the
  release gate; `npm run bench -- --count 10000` is.

Fuzzy search has **no** target here. The "Similar" toggle is opt-in and walks
every candidate's packed word list, so it is allowed to cost more than an exact
search. The benchmark still reports it against a number of its own, set at the
point where the feature stops feeling instant: the interface debounces at
120 ms, so anything past half a second reads as a hang.

CI runs the same benchmark at 2 000 notes against much looser budgets of its
own. Those exist to catch an order-of-magnitude regression on a shared runner,
not to reproduce the figures above; see `.github/workflows/ci.yml`.
