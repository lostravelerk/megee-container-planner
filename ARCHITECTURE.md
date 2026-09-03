# Container Planner v3 architecture

## Product boundary

The application is a loading-work productivity tool with two work areas only:

1. **Loading Planner** - one compact, spreadsheet-style SKU grid for both direct-carton and palletized mixed loads.
2. **Saved Loading Plans** - only plans explicitly saved after calculation. It is not a product master, catalogue, or batch pre-calculation store.

There is no single-product planner, public product snapshot, Cost-system connector, or Excel bulk pre-planning workflow.

## Planning modes

### Order quantity

Every SKU quantity is fixed by the order. The planner may never change it. Cartons are calculated independently with `ceil(EA / EA-per-carton)` and a partial carton occupies one full loading position.

### Container capacity

The user selects a standard container type and one or more containers. Each row has one purchasing rule:

- `fixed`: exact EA is mandatory;
- `adjustable`: EA may vary inside its min/target/max range;
- `kit`: rows with the same kit code have identical final EA, while carton counts still round independently.

The purchasing optimizer proposes quantities. Every candidate must then pass the existing physical carton/pallet planner and full geometry audit. A theoretical-CBM result is never considered executable.

## Optimization priorities

Hard constraints are evaluated before preferences:

1. Preserve fixed quantities and equal-EA kit groups.
2. Load every calculated carton/pallet without boundary, door, height, gap or overlap violations.
3. Respect the selected number and type of containers.
4. Prefer the highest physically verified utilization.
5. Prefer quantities closest to entered targets.
6. Prefer fewer partial cartons, fewer split SKUs and smaller continuous voids.

## Report model

HTML report and PDF use the same immutable calculated snapshot. HTML is the primary interactive reading format; print/PDF is its paginated projection. Packing List remains a separate PDF projection of the same snapshot.

Before any report opens or prints, the application checks:

- input row completeness;
- demand/optimized quantity, carton, pallet, EA and CBM reconciliation;
- per-container allocation totals;
- door and three-axis boundaries;
- non-overlap and configured gaps;
- tail-carton position and no-load-above rule;
- presence and row counts of all required tables and diagrams.

## Storage and privacy

Saved plans are versioned snapshots stored locally in the current browser. Opening the public URL does not expose another user's plan library. A short web share contains one explicit plan snapshot only; it never contains the local library.

## UI rules

- Sticky application header and sticky table header.
- SAP-style dense rows, visible focus state, clear numeric alignment and no decorative cards without a decision purpose.
- Header funnel opens a column filter; active filters are visible and can be cleared in one action.
- Desktop grid avoids page-level horizontal scrolling; narrow screens use row cards and local diagram scrolling.
- Branding is deliberately minimal. A text wordmark is preferred when a logo reduces usable space.

## Release gates

A release is blocked unless lint, production build, deterministic algorithm tests, responsive browser checks, print invocation checks, PDF text reconciliation and rendered-page visual QA all pass.
