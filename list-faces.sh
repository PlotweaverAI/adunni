#!/bin/bash
curl -s -H "x-api-key: b158ef876f5f4b299aed7744899016f9" https://tavusapi.com/v2/faces | python3 -c "
import sys, json
faces = json.load(sys.stdin)['data']
for f in faces:
    print(f\"{f['face_id']} | {f['face_name']} | {f.get('thumbnail_image_url', 'N/A')}\")
"
