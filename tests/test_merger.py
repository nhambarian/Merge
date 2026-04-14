"""Tests for the XML merger logic."""

import pytest
from datetime import datetime
import xml.etree.ElementTree as ET

from merger import merge_xml, get_element_time, parse_datetime


# ─── parse_datetime ───────────────────────────────────────────────────────────

class TestParseDatetime:
    def test_iso8601_full(self):
        assert parse_datetime("2024-01-15T14:30:00") == datetime(2024, 1, 15, 14, 30, 0)

    def test_iso8601_with_microseconds(self):
        assert parse_datetime("2024-01-15T14:30:00.000000") == datetime(2024, 1, 15, 14, 30, 0)

    def test_space_separated(self):
        assert parse_datetime("2024-01-15 14:30:00") == datetime(2024, 1, 15, 14, 30, 0)

    def test_date_only(self):
        assert parse_datetime("2024-01-15") == datetime(2024, 1, 15)

    def test_time_only_hms(self):
        assert parse_datetime("14:30:00") == datetime(1900, 1, 1, 14, 30, 0)

    def test_time_only_hm(self):
        assert parse_datetime("14:30") == datetime(1900, 1, 1, 14, 30, 0)

    def test_invalid_returns_none(self):
        assert parse_datetime("not-a-date") is None

    def test_strips_whitespace(self):
        assert parse_datetime("  2024-01-15T14:30:00  ") == datetime(2024, 1, 15, 14, 30, 0)


# ─── get_element_time ─────────────────────────────────────────────────────────

class TestGetElementTime:
    def _make_elem(self, tag="entry", attribs=None, children=None):
        elem = ET.Element(tag, attrib=attribs or {})
        for child_tag, child_text in (children or {}).items():
            child = ET.SubElement(elem, child_tag)
            child.text = child_text
        return elem

    def test_time_attribute(self):
        elem = self._make_elem(attribs={"time": "2024-01-15T10:00:00"})
        assert get_element_time(elem) == datetime(2024, 1, 15, 10, 0, 0)

    def test_timestamp_attribute(self):
        elem = self._make_elem(attribs={"timestamp": "2024-01-15T10:00:00"})
        assert get_element_time(elem) == datetime(2024, 1, 15, 10, 0, 0)

    def test_datetime_attribute(self):
        elem = self._make_elem(attribs={"datetime": "2024-01-15T10:00:00"})
        assert get_element_time(elem) == datetime(2024, 1, 15, 10, 0, 0)

    def test_date_attribute(self):
        elem = self._make_elem(attribs={"date": "2024-01-15"})
        assert get_element_time(elem) == datetime(2024, 1, 15)

    def test_time_child_element(self):
        elem = self._make_elem(children={"time": "2024-01-15T10:00:00"})
        assert get_element_time(elem) == datetime(2024, 1, 15, 10, 0, 0)

    def test_timestamp_child_element(self):
        elem = self._make_elem(children={"timestamp": "2024-01-15T10:00:00"})
        assert get_element_time(elem) == datetime(2024, 1, 15, 10, 0, 0)

    def test_no_time_returns_none(self):
        elem = self._make_elem(attribs={"value": "hello"})
        assert get_element_time(elem) is None

    def test_unparseable_value_returns_none(self):
        elem = self._make_elem(attribs={"time": "not-a-time"})
        assert get_element_time(elem) is None


# ─── merge_xml ────────────────────────────────────────────────────────────────

XML1 = """<events>
  <event time="2024-01-15T08:00:00">Morning briefing</event>
  <event time="2024-01-15T10:00:00">Mid-morning session</event>
  <event time="2024-01-15T12:00:00">Noon meeting</event>
</events>"""

XML2 = """<events>
  <event time="2024-01-15T12:00:00">Afternoon kick-off</event>
  <event time="2024-01-15T14:00:00">Afternoon session</event>
  <event time="2024-01-15T16:00:00">End of day</event>
</events>"""

CUTOFF = datetime(2024, 1, 15, 12, 0, 0)


class TestMergeXml:
    def _parse(self, xml_str):
        return ET.fromstring(xml_str)

    def test_basic_merge(self):
        result = merge_xml(XML1, XML2, CUTOFF)
        root = self._parse(result)
        texts = [e.text for e in root]
        # Before noon -> from XML1
        assert "Morning briefing" in texts
        assert "Mid-morning session" in texts
        # Noon and after -> from XML2
        assert "Afternoon kick-off" in texts
        assert "Afternoon session" in texts
        assert "End of day" in texts
        # "Noon meeting" from XML1 is excluded (not < cutoff)
        assert "Noon meeting" not in texts

    def test_result_is_sorted(self):
        result = merge_xml(XML1, XML2, CUTOFF)
        root = self._parse(result)
        times = [get_element_time(e) for e in root]
        assert times == sorted(times)

    def test_root_tag_from_xml1(self):
        result = merge_xml(XML1, XML2, CUTOFF)
        root = self._parse(result)
        assert root.tag == "events"

    def test_all_from_xml1_when_early_cutoff(self):
        early = datetime(2024, 1, 14)  # Before any element
        result = merge_xml(XML1, XML2, early)
        root = self._parse(result)
        texts = [e.text for e in root]
        # All XML2 elements (cutoff is before all), no XML1 elements
        assert "Afternoon kick-off" in texts
        assert "Morning briefing" not in texts

    def test_all_from_xml1_when_late_cutoff(self):
        late = datetime(2024, 1, 16)  # After all elements
        result = merge_xml(XML1, XML2, late)
        root = self._parse(result)
        texts = [e.text for e in root]
        # All XML1 elements (cutoff is after all), no XML2 elements
        assert "Morning briefing" in texts
        assert "Afternoon kick-off" not in texts

    def test_invalid_xml1_raises_value_error(self):
        with pytest.raises(ValueError, match="Could not parse first XML file"):
            merge_xml("<bad xml", XML2, CUTOFF)

    def test_invalid_xml2_raises_value_error(self):
        with pytest.raises(ValueError, match="Could not parse second XML file"):
            merge_xml(XML1, "<bad xml", CUTOFF)

    def test_no_time_elements_raises_value_error(self):
        xml_no_time = "<data><item value='1'/><item value='2'/></data>"
        with pytest.raises(ValueError, match="No child elements"):
            merge_xml(xml_no_time, xml_no_time, CUTOFF)

    def test_timestamp_attribute(self):
        xml_ts1 = """<log>
  <entry timestamp="2024-01-15T08:00:00">First</entry>
  <entry timestamp="2024-01-15T11:00:00">Second</entry>
</log>"""
        xml_ts2 = """<log>
  <entry timestamp="2024-01-15T12:00:00">Third</entry>
</log>"""
        result = merge_xml(xml_ts1, xml_ts2, CUTOFF)
        root = self._parse(result)
        texts = [e.text for e in root]
        assert "First" in texts
        assert "Second" in texts
        assert "Third" in texts

    def test_child_element_time(self):
        xml_child1 = """<records>
  <record><time>2024-01-15T08:00:00</time><value>Alpha</value></record>
  <record><time>2024-01-15T11:00:00</time><value>Beta</value></record>
</records>"""
        xml_child2 = """<records>
  <record><time>2024-01-15T12:00:00</time><value>Gamma</value></record>
</records>"""
        result = merge_xml(xml_child1, xml_child2, CUTOFF)
        root = self._parse(result)
        values = [r.findtext("value") for r in root]
        assert "Alpha" in values
        assert "Beta" in values
        assert "Gamma" in values

    def test_preserves_root_attributes(self):
        xml_with_attr = """<events version="1.0" source="system">
  <event time="2024-01-15T08:00:00">Early</event>
</events>"""
        result = merge_xml(xml_with_attr, XML2, CUTOFF)
        root = self._parse(result)
        assert root.get("version") == "1.0"
        assert root.get("source") == "system"

    def test_element_count(self):
        result = merge_xml(XML1, XML2, CUTOFF)
        root = self._parse(result)
        # 2 from XML1 (before noon) + 3 from XML2 (noon onward) = 5
        assert len(list(root)) == 5
