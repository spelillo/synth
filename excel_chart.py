# Runs in the browser under Pyodide (see charts.js -> loadExcelEngine), so
# query results never leave the user's machine. Builds a 2-sheet workbook:
#   "Data"  - the query results as a formatted Excel Table
#   "Chart" - a native Excel chart whose series reference the Data cells, so
#             editing a value (or adding a row inside the table) updates it.
import io
import json

import xlsxwriter

PALETTE = ["#EB6834", "#2A78D6", "#1BAF7A", "#4A3AA7", "#EDA100", "#E87BA4"]
INK = "#201515"
INK_2 = "#605D52"
GRID = "#E6E1D6"
AXIS = "#BFB8A8"

EXCEL_TYPES = {
    "column": {"type": "column"},
    "bar": {"type": "bar"},
    "line": {"type": "line"},
    "area": {"type": "area"},
    "pie": {"type": "pie"},
    "doughnut": {"type": "doughnut"},
    "scatter": {"type": "scatter"},
}


def _unique_headers(columns):
    # Excel Table headers must be unique and non-empty; SQL results can
    # repeat a name (e.g. two "id" columns from a join).
    used = set()
    headers = []
    for raw in columns:
        base = str(raw).strip()[:250] or "Column"
        name, k = base, 2
        while name.lower() in used:
            name, k = f"{base} ({k})", k + 1
        used.add(name.lower())
        headers.append(name)
    return headers


def _column_is_integer(rows, c):
    for row in rows[:5000]:
        v = row[c]
        if isinstance(v, float) and not v.is_integer():
            return False
    return True


def build_xlsx(payload_json):
    p = json.loads(payload_json)
    columns = p["columns"]
    rows = p["rows"]
    numeric = set(p["numericColumns"])
    spec = p["spec"]
    chart_type = spec["type"]
    n = len(rows)
    ncols = len(columns)

    buf = io.BytesIO()
    # strings_to_formulas off: a cell whose text starts with "=" is written
    # as text, never executed as a formula when the file is opened.
    wb = xlsxwriter.Workbook(buf, {
        "in_memory": True,
        "strings_to_numbers": False,
        "strings_to_formulas": False,
        "strings_to_urls": False,
    })
    wb.set_properties({"title": spec["title"], "comments": "Created with Synth (synth-sql.com)"})

    ws = wb.add_worksheet("Data")
    int_fmt = wb.add_format({"num_format": "#,##0"})
    dec_fmt = wb.add_format({"num_format": "#,##0.00"})
    col_fmt = {}
    for c in numeric:
        col_fmt[c] = int_fmt if _column_is_integer(rows, c) else dec_fmt

    for r, row in enumerate(rows, start=1):
        for c in range(ncols):
            v = row[c]
            if v is None or v == "":
                continue
            if c in numeric and isinstance(v, (int, float)) and not isinstance(v, bool):
                ws.write_number(r, c, v, col_fmt[c])
            else:
                ws.write_string(r, c, str(v))

    headers = _unique_headers(columns)
    ws.add_table(0, 0, max(n, 1), ncols - 1, {
        "name": "QueryResults",
        "style": "Table Style Medium 2",
        "columns": [{"header": h} for h in headers],
    })
    for c in range(ncols):
        longest = len(headers[c]) + 3
        for row in rows[:1000]:
            v = row[c]
            if v is not None:
                longest = max(longest, len(f"{v:,.2f}" if isinstance(v, float) else str(v)))
        ws.set_column(c, c, min(max(longest + 2, 8), 50))
    ws.freeze_panes(1, 0)

    chart = wb.add_chart(EXCEL_TYPES[chart_type])
    cat = spec["category"]
    values = spec["values"]
    is_pie = chart_type in ("pie", "doughnut")
    single = len(values) == 1

    for i, vc in enumerate(values):
        color = PALETTE[i % len(PALETTE)]
        s = {
            "name": ["Data", 0, vc],
            "values": ["Data", 1, vc, n, vc],
        }
        if cat is not None and cat >= 0:
            s["categories"] = ["Data", 1, cat, n, cat]
        label_fmt = "#,##0" if col_fmt.get(vc) is int_fmt else "#,##0.00"

        if chart_type in ("column", "bar"):
            s["fill"] = {"color": color}
            s["border"] = {"none": True}
            s["gap"] = 70
            s["overlap"] = -8
            if single and n <= 20:
                s["data_labels"] = {"value": True, "num_format": label_fmt,
                                    "font": {"color": INK_2, "size": 9}}
        elif chart_type == "line":
            s["line"] = {"color": color, "width": 2.25}
            if n <= 40:
                s["marker"] = {"type": "circle", "size": 6, "fill": {"color": color},
                               "border": {"color": "#FFFFFF", "width": 1.5}}
            else:
                s["marker"] = {"type": "none"}
        elif chart_type == "area":
            s["fill"] = {"color": color, "transparency": 80}
            s["line"] = {"color": color, "width": 2}
        elif chart_type == "scatter":
            s["marker"] = {"type": "circle", "size": 7, "fill": {"color": color},
                           "border": {"color": "#FFFFFF", "width": 1}}
        elif is_pie:
            s["points"] = [{"fill": {"color": PALETTE[j % len(PALETTE)]},
                            "border": {"color": "#FFFFFF", "width": 2}} for j in range(n)]
            s["data_labels"] = {"percentage": True, "leader_lines": True,
                                "font": {"color": INK, "size": 10}}
            if chart_type == "pie":
                s["data_labels"]["position"] = "outside_end"
        chart.add_series(s)

    chart.set_title({"name": spec["title"], "overlay": False,
                     "name_font": {"size": 16, "bold": True, "color": INK}})
    chart.set_chartarea({"border": {"none": True}, "fill": {"color": "#FFFFFF"}})

    if is_pie:
        chart.set_legend({"position": "right", "font": {"color": INK_2, "size": 10}})
        if chart_type == "doughnut":
            chart.set_hole_size(55)
    else:
        if single:
            chart.set_legend({"none": True})
        else:
            chart.set_legend({"position": "bottom", "font": {"color": INK_2, "size": 10}})

        axis_title_font = {"size": 11, "bold": False, "color": INK_2}
        tick_font = {"size": 9, "color": INK_2}
        cat_axis = {
            "name": spec.get("xAxisTitle") or None,
            "name_font": axis_title_font,
            "num_font": dict(tick_font),
            "line": {"color": AXIS},
            "major_gridlines": {"visible": False},
            "major_tick_mark": "none",
        }
        val_axis = {
            "name": spec.get("yAxisTitle") or None,
            "name_font": axis_title_font,
            "num_font": tick_font,
            "num_format": "General" if any(col_fmt.get(v) is dec_fmt for v in values) else "#,##0",
            "line": {"none": True},
            "major_gridlines": {"visible": True, "line": {"color": GRID, "width": 0.75}},
            "major_tick_mark": "none",
        }
        if chart_type == "bar":
            # In a horizontal bar chart XlsxWriter's x_axis is the (horizontal)
            # value axis and y_axis the category axis. Excel lists the first
            # row at the bottom; reverse so it reads top-down like the table,
            # and cross at the max category to keep the value axis at the bottom.
            cat_axis["reverse"] = True
            cat_axis["crossing"] = "max"
            chart.set_x_axis(val_axis)
            chart.set_y_axis(cat_axis)
        else:
            if chart_type != "scatter" and n > 12:
                cat_axis["num_font"]["rotation"] = -45
            chart.set_x_axis(cat_axis)
            chart.set_y_axis(val_axis)

    cs = wb.add_chartsheet("Chart")
    cs.set_chart(chart)
    cs.activate()

    wb.close()
    return buf.getvalue()
