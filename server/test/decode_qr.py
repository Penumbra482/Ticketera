"""Decodifica con OpenCV las matrices QR que genera web/app/lib/qr.js.

No forma parte de la aplicación: es la contraprueba independiente del
generador propio. Lee un JSON por stdin y escribe otro por stdout.

Probamos con los dos detectores de OpenCV y a dos escalas: los lectores reales
tienen la misma tolerancia, pero el detector clásico a veces falla con códigos
densos y no queremos un test que dependa de esa suerte.
"""

import json
import sys

import cv2
import numpy as np

QUIET = 4

cases = json.load(sys.stdin)
detectors = [cv2.QRCodeDetectorAruco(), cv2.QRCodeDetector()]
out = []

for case in cases:
    size = case["size"]
    bits = np.array([int(c) for c in case["modules"]], dtype=np.uint8).reshape(size, size)
    base = np.where(bits == 1, 0, 255).astype(np.uint8)

    decoded = ""
    for scale in (4, 8):
        img = np.kron(base, np.ones((scale, scale), dtype=np.uint8))
        img = np.pad(img, QUIET * scale, constant_values=255)
        for detector in detectors:
            try:
                text, _, _ = detector.detectAndDecode(img)
            except Exception:
                text = ""
            if text == case["text"]:
                decoded = text
                break
            if text and not decoded:
                decoded = text  # guardamos la lectura errónea para el informe
        if decoded == case["text"]:
            break

    out.append({"label": case["label"], "decoded": decoded, "ok": decoded == case["text"]})

json.dump(out, sys.stdout)
