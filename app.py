"""
Flask web application for merging two XML files based on a selected time cutoff.
"""

from datetime import datetime
from flask import Flask, render_template, request, Response
from merger import merge_xml, DATETIME_FORMATS

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB upload limit


@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


@app.route("/merge", methods=["POST"])
def merge():
    errors = []

    file1 = request.files.get("file1")
    file2 = request.files.get("file2")
    cutoff_str = request.form.get("cutoff_time", "").strip()

    if not file1 or file1.filename == "":
        errors.append("Please upload the first XML file.")
    if not file2 or file2.filename == "":
        errors.append("Please upload the second XML file.")
    if not cutoff_str:
        errors.append("Please select a cutoff date/time.")

    if errors:
        return render_template("index.html", errors=errors), 400

    # Parse cutoff time (HTML datetime-local gives "YYYY-MM-DDTHH:MM")
    cutoff_time = None
    for fmt in DATETIME_FORMATS:
        try:
            cutoff_time = datetime.strptime(cutoff_str, fmt)
            break
        except ValueError:
            continue

    if cutoff_time is None:
        errors.append(f"Could not parse the cutoff time: '{cutoff_str}'.")
        return render_template("index.html", errors=errors), 400

    try:
        xml1_content = file1.read().decode("utf-8")
        xml2_content = file2.read().decode("utf-8")
        merged_xml = merge_xml(xml1_content, xml2_content, cutoff_time)
    except (ValueError, UnicodeDecodeError) as exc:
        errors.append(str(exc))
        return render_template("index.html", errors=errors), 400

    return Response(
        merged_xml,
        mimetype="application/xml",
        headers={
            "Content-Disposition": "attachment; filename=merged.xml"
        },
    )


if __name__ == "__main__":
    import os
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(debug=debug, host="0.0.0.0", port=5000)
