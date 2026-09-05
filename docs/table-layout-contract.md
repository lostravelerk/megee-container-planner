# MEGEE data table contract

This contract is mandatory for planner, saved-plan library, HTML report and planner Packing List tables. The standalone product and shipment modules were retired in v6.2. It concerns presentation only; it must not constrain SKU placement coordinates.

1. Text, SKU and dimensions: left aligned. Scalar numbers: right aligned. Sequence numbers and actions: centered. A column's header and body must have identical alignment. All cells are vertically centered.
2. Use `data-table` plus `numeric` / `center` on BOTH header and data cells. Legacy tables have paired header/body column maps in `app/data-tables.css`. Changing columns requires updating those maps and their regression tests. No per-screen alignment override is permitted.
3. Numeric inputs are right aligned, text inputs left aligned. Use tabular figures. Do not break a numeric token or `EA/BOX` within the token. Place units in headings; compound dimensions can wrap only between components.
4. Fixed precision within each field: quantities and counts 0 decimals; weights 3; single-carton CBM and CBM per 10,000 EA 6; shipment transport CBM 6; compact planner total CBM 2; percentages 1; dimension precision up to 2 where needed. Never round intermediate geometry to display precision. Missing values use `—`, not zero.
5. Desktop aligns cells as a table. Small screens use existing labeled entry cards or horizontal scrolling limited to the table, never page-wide overflow or reduced illegible text. Touch inputs remain at least 44 px high.
6. Printed tables repeat headers, allow page continuation, keep individual rows intact, and keep headings with following content. Do not apply keep-together to an entire long table. Totals, notes and signature lines use a consistent grid and margins.
7. Validate changes with automated tests plus desktop/mobile UI inspection. Actual PDF pagination requires rendered PDF inspection; passing CSS tests is not proof that printed pages are flawless.

## Weight convention

Current drafts use standard-carton business weights: net = gross − 1 kg, locked. Partial cartons use proportional product net rounded to grams, plus 1 kg carton tare, explicitly labeled estimated. Missing gross remains unknown. Totals exclude pallets and external auxiliary materials and are not container payload checks or VGM declarations. Confirmed historical snapshots keep their original convention; new revisions adopt the current convention.
