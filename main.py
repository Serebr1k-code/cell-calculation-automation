import base64
import os

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request

def remove_duplicate_detections(cells, min_distance=7):

    if not cells:
        return []
    
    grid = {}
    unique_cells = []
    
    for cx, cy in cells:
        gx = int(cx // min_distance)
        gy = int(cy // min_distance)
        
        is_duplicate = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                neighbor_key = (gx + dx, gy + dy)
                if neighbor_key in grid:
                    for (nx, ny) in grid[neighbor_key]:
                        if (cx - nx) ** 2 + (cy - ny) ** 2 < min_distance ** 2:
                            is_duplicate = True
                            break
                    if is_duplicate:
                        break
        
        if not is_duplicate:
            unique_cells.append((cx, cy))
            grid.setdefault((gx, gy), []).append((cx, cy))
    
    return unique_cells


def detect_erythrocytes(img, show_preview=False, draw_cells=True):
    
    result_img = img.copy()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    tile_size, overlap = 512, 32
    all_candidates = []
    
    for y in range(0, gray.shape[0], tile_size - overlap):
        for x in range(0, gray.shape[1], tile_size - overlap):
            y2 = min(y + tile_size, gray.shape[0])
            x2 = min(x + tile_size, gray.shape[1])
            tile = gray[y:y2, x:x2]

            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            blackhat = cv2.morphologyEx(tile, cv2.MORPH_BLACKHAT, kernel)

            _, thresh = cv2.threshold(blackhat, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)

            kernel_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
            thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel_small)

            num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(thresh, connectivity=8)

            for i in range(1, num_labels):
                area = stats[i, cv2.CC_STAT_AREA]
                cx, cy = centroids[i]

                if 20 < area < 80:
                    all_candidates.append((int(cx) + x, int(cy) + y))

                elif area >= 80:
                    blob_mask = (labels == i).astype(np.uint8) * 255
                    dist_transform = cv2.distanceTransform(blob_mask, cv2.DIST_L2, 5)

                    _, sure_fg = cv2.threshold(dist_transform, 0.7 * dist_transform.max(), 255, 0)
                    sure_fg = np.uint8(sure_fg)

                    num_fg_labels, fg_labels, _, fg_centroids = cv2.connectedComponentsWithStats(sure_fg, connectivity=8)

                    for j in range(1, num_fg_labels):
                        fg_cx, fg_cy = fg_centroids[j]
                        all_candidates.append((int(fg_cx) + x, int(fg_cy) + y))
    
    cells = remove_duplicate_detections(all_candidates, min_distance=7)
    
    if draw_cells:
        for (cx, cy) in cells:
            cv2.rectangle(
                result_img,
                (cx - 4, cy - 4),
                (cx + 4, cy + 4),
                color=(200, 255, 0),  # Светло-зелёный
                thickness=1
            )
    
    if show_preview:
        preview_h = min(800, int(800 * result_img.shape[0] / result_img.shape[1]))
        preview = cv2.resize(result_img, (800, preview_h))
        cv2.imshow('Результат', preview)
        cv2.waitKey(0)
        cv2.destroyAllWindows()
    
    return cells, result_img


app = Flask(__name__)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/process', methods=['POST'])
def process_image():
    if 'image' not in request.files:
        return jsonify({'error': 'Файл не передан'}), 400

    image_file = request.files['image']
    if image_file.filename == '':
        return jsonify({'error': 'Выберите файл'}), 400

    file_bytes = np.frombuffer(image_file.read(), np.uint8)
    input_img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    if input_img is None:
        return jsonify({'error': 'Не удалось прочитать изображение'}), 400

    try:
        cells, result = detect_erythrocytes(
            input_img,
            show_preview=False,
            draw_cells=False
        )
    except Exception as exc:
        return jsonify({'error': f'Ошибка обработки: {str(exc)}'}), 500

    success, encoded_image = cv2.imencode('.png', result)
    if not success:
        return jsonify({'error': 'Не удалось закодировать результат'}), 500

    image_base64 = base64.b64encode(encoded_image.tobytes()).decode('utf-8')

    return jsonify({
        'count': len(cells),
        'resultImageData': f"data:image/png;base64,{image_base64}",
        'cells': [[int(cx), int(cy)] for cx, cy in cells],
        'imageWidth': int(result.shape[1]),
        'imageHeight': int(result.shape[0])
    })


if __name__ == "__main__":
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=False)