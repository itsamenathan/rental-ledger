# Scanner page-detection check

Synthetic phone-sized photos (3024×4032) with known page corners, for checking changes to `src/scanner/detect.ts`.
Needs ImageMagick (`magick`) and Python 3. The images are generated, not committed.

```sh
python3 scripts/scanner-eval/make-set.py /tmp/scan-set                    # 12 cases: dark, light+shadow, busy, off-frame, placemat, invoice, small, white, wood, blurry, finger, curled
python3 scripts/scanner-eval/make-holdout.py /tmp/scan-holdout /tmp/scan-set  # 7 more (uses the first set's page images)
vp env exec --node 24 node scripts/scanner-eval/evaluate.mjs "$PWD" /tmp/scan-set
vp env exec --node 24 node scripts/scanner-eval/evaluate.mjs "$PWD" /tmp/scan-holdout
```

`evaluate.mjs` prints each photo's worst-corner error as a percentage of the diagonal (under 1.5% looks right on
screen). Tune against both sets so a fix for one case doesn't just fit these pictures. "curled" has approximate
ground truth (the wave distortion moves the corners), so ~1.7% there is expected.

As of the switch from OpenCV: 11/12 and 7/7, all passing cases ≤ 0.14%.
