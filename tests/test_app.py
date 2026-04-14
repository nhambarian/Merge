"""Tests for the Flask web application routes."""

import io
import pytest
from app import app as flask_app


MORNING_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<events>
  <event time="2024-01-15T08:00:00">Morning briefing</event>
  <event time="2024-01-15T11:00:00">Late morning</event>
</events>"""

AFTERNOON_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<events>
  <event time="2024-01-15T12:00:00">Afternoon kick-off</event>
  <event time="2024-01-15T16:00:00">End of day</event>
</events>"""


@pytest.fixture
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


def _post_merge(client, file1=MORNING_XML, file2=AFTERNOON_XML, cutoff="2024-01-15T12:00"):
    data = {
        "file1": (io.BytesIO(file1), "file1.xml"),
        "file2": (io.BytesIO(file2), "file2.xml"),
        "cutoff_time": cutoff,
    }
    return client.post("/merge", data=data, content_type="multipart/form-data")


class TestIndex:
    def test_get_returns_200(self, client):
        r = client.get("/")
        assert r.status_code == 200

    def test_get_contains_form(self, client):
        r = client.get("/")
        assert b"file1" in r.data
        assert b"file2" in r.data
        assert b"cutoff_time" in r.data


class TestMergeEndpoint:
    def test_successful_merge_returns_xml(self, client):
        r = _post_merge(client)
        assert r.status_code == 200
        assert "application/xml" in r.content_type

    def test_successful_merge_has_download_header(self, client):
        r = _post_merge(client)
        assert "attachment" in r.headers.get("Content-Disposition", "")
        assert "merged.xml" in r.headers.get("Content-Disposition", "")

    def test_merged_content_is_valid_xml(self, client):
        import xml.etree.ElementTree as ET
        r = _post_merge(client)
        root = ET.fromstring(r.data)
        assert root is not None

    def test_elements_from_both_files(self, client):
        r = _post_merge(client)
        assert b"Morning briefing" in r.data
        assert b"Afternoon kick-off" in r.data

    def test_missing_file1_returns_400(self, client):
        data = {
            "file2": (io.BytesIO(AFTERNOON_XML), "file2.xml"),
            "cutoff_time": "2024-01-15T12:00",
        }
        r = client.post("/merge", data=data, content_type="multipart/form-data")
        assert r.status_code == 400
        assert b"first XML file" in r.data

    def test_missing_file2_returns_400(self, client):
        data = {
            "file1": (io.BytesIO(MORNING_XML), "file1.xml"),
            "cutoff_time": "2024-01-15T12:00",
        }
        r = client.post("/merge", data=data, content_type="multipart/form-data")
        assert r.status_code == 400
        assert b"second XML file" in r.data

    def test_missing_cutoff_returns_400(self, client):
        data = {
            "file1": (io.BytesIO(MORNING_XML), "file1.xml"),
            "file2": (io.BytesIO(AFTERNOON_XML), "file2.xml"),
        }
        r = client.post("/merge", data=data, content_type="multipart/form-data")
        assert r.status_code == 400
        assert b"cutoff" in r.data.lower()

    def test_invalid_xml_returns_400(self, client):
        r = _post_merge(client, file1=b"<bad xml")
        assert r.status_code == 400
        assert b"Could not parse" in r.data

    def test_invalid_cutoff_returns_400(self, client):
        r = _post_merge(client, cutoff="not-a-date")
        assert r.status_code == 400
        assert b"not-a-date" in r.data
