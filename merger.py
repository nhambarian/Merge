"""
XML merger module: merges two XML files based on a selected time cutoff.

Each XML file is expected to have a root element containing child elements
(records/entries/events). Each child element must have a time value, which
can be provided as:
  - an attribute named: time, timestamp, datetime, or date
  - a child element with one of those tag names

Merging strategy:
  - Elements from file_1 where element_time < cutoff_time
  - Elements from file_2 where element_time >= cutoff_time
  - Results are sorted by time and wrapped in the root element of file_1
"""

import xml.etree.ElementTree as ET
import defusedxml.ElementTree as DefusedET
from datetime import datetime
from typing import Optional

TIME_ATTRS = ("time", "timestamp", "datetime", "date")
DATETIME_FORMATS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%H:%M:%S",
    "%H:%M",
)


def parse_datetime(value: str) -> Optional[datetime]:
    """Try to parse a datetime string using common formats. Returns None on failure."""
    value = value.strip()
    for fmt in DATETIME_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def get_element_time(element: ET.Element) -> Optional[datetime]:
    """
    Extract the time value from an XML element.
    Checks attributes first, then child elements, using common time-related names.
    """
    for attr in TIME_ATTRS:
        value = element.get(attr)
        if value is not None:
            parsed = parse_datetime(value)
            if parsed is not None:
                return parsed

    for attr in TIME_ATTRS:
        child = element.find(attr)
        if child is not None and child.text:
            parsed = parse_datetime(child.text)
            if parsed is not None:
                return parsed

    return None


def merge_xml(
    xml1_content: str,
    xml2_content: str,
    cutoff_time: datetime,
) -> str:
    """
    Merge two XML documents based on a cutoff time.

    Elements from xml1 with time < cutoff_time are kept.
    Elements from xml2 with time >= cutoff_time are kept.
    The merged elements are sorted by time and returned as an XML string
    wrapped in the root element taken from xml1.

    Args:
        xml1_content: String content of the first XML file.
        xml2_content: String content of the second XML file.
        cutoff_time: The datetime cutoff; xml1 elements before this time and
                     xml2 elements from this time onward are included.

    Returns:
        A UTF-8 XML string with the merged content.

    Raises:
        ValueError: If either file cannot be parsed as XML, or if no child
                    elements have recognizable time values.
    """
    try:
        root1 = DefusedET.fromstring(xml1_content)
    except Exception as exc:
        raise ValueError(f"Could not parse first XML file: {exc}") from exc

    try:
        root2 = DefusedET.fromstring(xml2_content)
    except Exception as exc:
        raise ValueError(f"Could not parse second XML file: {exc}") from exc

    # Build the merged root, copying tag and attributes from root1
    merged_root = ET.Element(root1.tag, attrib=dict(root1.attrib))

    kept: list[tuple[datetime, ET.Element]] = []

    for child in root1:
        t = get_element_time(child)
        if t is not None and t < cutoff_time:
            kept.append((t, child))

    for child in root2:
        t = get_element_time(child)
        if t is not None and t >= cutoff_time:
            kept.append((t, child))

    if not kept:
        raise ValueError(
            "No child elements with recognizable time values were found in "
            "either file. Each child element must have a 'time', 'timestamp', "
            "'datetime', or 'date' attribute (or child element)."
        )

    kept.sort(key=lambda pair: pair[0])

    for _, element in kept:
        merged_root.append(element)

    ET.indent(merged_root, space="  ")
    return ET.tostring(merged_root, encoding="unicode", xml_declaration=False)
