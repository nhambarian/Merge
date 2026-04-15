# XML Merge Dashboard

Browser-based dashboard to merge two XML files in three steps:

1. Drag and drop **XML File 1** and **XML File 2**
2. Pick the designated start time (inside XML File 1) where XML File 2 should begin
3. Generate a preview with source highlighting and export the merged XML

## Run

Because this is a static web app, you can run it with any simple HTTP server.

### Option A: Python

```bash
cd /workspace
python3 -m http.server 8000
```

Open: `http://localhost:8000`

## XML timing expectation

The dashboard reads time from element attributes in either file using one of:

- `time`
- `start`
- `timestamp`
- `t`
- `begin`

Supported time formats:

- Numeric seconds (example: `12.5`)
- Broadcast timecode `HH:MM:SS;FF` (drop-frame, 59.94 fps)
- Broadcast-style entry `HH:MM:SS:FF` is also accepted in Step 2 input
- `MM:SS(.mmm)`
- `HH:MM:SS(.mmm)`

## Merge behavior

- XML File 1 is included from its beginning **up to the selected insertion time**
- XML File 2 is then inserted starting at that designated time
- A preview window shows:
  - **Light blue** lines for XML File 1
  - **Light red** lines for XML File 2
- Export downloads a single merged XML file
