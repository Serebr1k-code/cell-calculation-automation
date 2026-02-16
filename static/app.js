const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
const menuButton = document.getElementById('menuButton');
const detectorButtons = document.querySelectorAll('.detector-item');

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const dropPrompt = document.getElementById('dropPrompt');
const previewImage = document.getElementById('previewImage');
const regionsLayer = document.getElementById('regionsLayer');
const cellsLayer = document.getElementById('cellsLayer');
const linesLayer = document.getElementById('linesLayer');
const pointsLayer = document.getElementById('pointsLayer');
const undoPointButton = document.getElementById('undoPointButton');

const processButton = document.getElementById('processButton');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const resultStats = document.getElementById('resultStats');
const cellsCountText = document.getElementById('cellsCountText');
const cellsPerMclText = document.getElementById('cellsPerMclText');
const cellsPerLText = document.getElementById('cellsPerLText');

let selectedFile = null;
let progressTimer = null;
let isProcessed = false;
let currentObjectUrl = null;
const edgePoints = [];
let pointCounter = 0;
let detectedCells = [];
let detectedImageWidth = 0;
let detectedImageHeight = 0;

let zoom = 1;
let panX = 0;
let panY = 0;
const EDGE_SNAP_DISTANCE = 40;
const EDGE_SNAP_RATIO = 0.08;
const REGION_MAX_SIDE = 420;
const AREA_MATCH_TOLERANCE = 0.25;
const REGION_MERGE_RADIUS = 3;
const REQUIRED_PARTS_PER_STRUCTURE = 16;
const PAN_START_THRESHOLD = 10;
const CELL_HALF_SIZE = 4;
const POINT_VISUAL_INSET = 5;

let dragMode = 'idle';
let pointerStartX = 0;
let pointerStartY = 0;
let initialPanX = 0;
let initialPanY = 0;
let activePointId = null;
let suppressNextClick = false;
let pointerMovedDistance = 0;

function openSidebar() {
  sidebar.classList.add('open');
  overlay.classList.add('active');
  menuButton.setAttribute('aria-expanded', 'true');
  sidebar.setAttribute('aria-hidden', 'false');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('active');
  menuButton.setAttribute('aria-expanded', 'false');
  sidebar.setAttribute('aria-hidden', 'true');
}

function applyImageTransform() {
  previewImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  renderOverlay();
}

function resetImageTransform() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyImageTransform();
}

function setProcessMode() {
  processButton.textContent = 'Обработать';
  processButton.classList.remove('delete-mode');
  processButton.disabled = !selectedFile;
}

function setDeleteMode() {
  processButton.textContent = 'Удалить';
  processButton.classList.add('delete-mode');
  processButton.disabled = false;
}

function clearCurrentObjectUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function clearEdgePoints() {
  edgePoints.length = 0;
  renderOverlay();
  undoPointButton.disabled = true;
}

function getEdgePointById(pointId) {
  return edgePoints.find((point) => point.id === pointId);
}

function clearRegionsLayer() {
  regionsLayer.innerHTML = '';
}

function clearCellsLayer() {
  cellsLayer.innerHTML = '';
}

function clearDetectedCells() {
  detectedCells = [];
  detectedImageWidth = 0;
  detectedImageHeight = 0;
  clearCellsLayer();
}

function formatWithCommas(value) {
  return Number(value).toLocaleString('en-US');
}

function updateResultStats(selectedCellsCount, smallSquaresCount) {
  if (!isProcessed) {
    resultStats.hidden = true;
    cellsCountText.textContent = '';
    cellsPerMclText.textContent = '';
    cellsPerLText.textContent = '';
    return;
  }

  const denominator = Math.max(0, Number(smallSquaresCount) || 0);
  let cellsPerMcl = 0;

  if (denominator > 0) {
    cellsPerMcl = Math.round((selectedCellsCount * 4000 * 200) / denominator);
  }

  const cellsPerL = cellsPerMcl * 1000000;

  cellsCountText.textContent = `клеток - ${formatWithCommas(selectedCellsCount)}`;
  cellsPerMclText.textContent = `кл/мкл - ${formatWithCommas(cellsPerMcl)} = (${selectedCellsCount}*4000*200)/${denominator}`;
  cellsPerLText.textContent = `кл/л - ${formatWithCommas(cellsPerL)}`;
  resultStats.hidden = false;
}

function isPreviewVisible() {
  return window.getComputedStyle(previewImage).display !== 'none';
}

function getImageRect() {
  if (!isPreviewVisible()) {
    return null;
  }

  const rect = previewImage.getBoundingClientRect();
  const naturalWidth = previewImage.naturalWidth || detectedImageWidth || 1;
  const naturalHeight = previewImage.naturalHeight || detectedImageHeight || 1;

  if (naturalWidth <= 0 || naturalHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return rect;
  }

  const containerRatio = rect.width / rect.height;
  const imageRatio = naturalWidth / naturalHeight;

  let renderWidth;
  let renderHeight;

  if (imageRatio > containerRatio) {
    renderWidth = rect.width;
    renderHeight = rect.width / imageRatio;
  } else {
    renderHeight = rect.height;
    renderWidth = rect.height * imageRatio;
  }

  const offsetX = (rect.width - renderWidth) / 2;
  const offsetY = (rect.height - renderHeight) / 2;

  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    right: rect.left + offsetX + renderWidth,
    bottom: rect.top + offsetY + renderHeight,
    width: renderWidth,
    height: renderHeight
  };
}

function getDropZoneRect() {
  return dropZone.getBoundingClientRect();
}

function toDropzonePoint(x, y) {
  const zone = getDropZoneRect();
  return {
    x: x - zone.left,
    y: y - zone.top
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) {
    return mask.slice();
  }

  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      let found = 0;

      for (let ny = y0; ny <= y1 && !found; ny += 1) {
        for (let nx = x0; nx <= x1; nx += 1) {
          if (mask[ny * width + nx]) {
            found = 1;
            break;
          }
        }
      }

      out[y * width + x] = found;
    }
  }

  return out;
}

function drawBlockedLine(mask, width, height, x0, y0, x1, y1) {
  const xStart = Math.round(clamp(x0, 0, width - 1));
  const yStart = Math.round(clamp(y0, 0, height - 1));
  const xEnd = Math.round(clamp(x1, 0, width - 1));
  const yEnd = Math.round(clamp(y1, 0, height - 1));

  const dx = Math.abs(xEnd - xStart);
  const dy = Math.abs(yEnd - yStart);
  const sx = xStart < xEnd ? 1 : -1;
  const sy = yStart < yEnd ? 1 : -1;
  let err = dx - dy;
  let x = xStart;
  let y = yStart;

  while (true) {
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const tx = x + ox;
        const ty = y + oy;
        if (tx >= 0 && tx < width && ty >= 0 && ty < height) {
          mask[ty * width + tx] = 1;
        }
      }
    }

    if (x === xEnd && y === yEnd) {
      break;
    }

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function computeHighlightMask(imageRect, pairs) {
  if (!pairs.length) {
    return null;
  }

  const sourceWidth = Math.max(8, Math.round(imageRect.width));
  const sourceHeight = Math.max(8, Math.round(imageRect.height));

  const scale = Math.min(1, REGION_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(8, Math.round(sourceWidth * scale));
  const height = Math.max(8, Math.round(sourceHeight * scale));
  const size = width * height;

  const blocked = new Uint8Array(size);

  for (let x = 0; x < width; x += 1) {
    blocked[x] = 1;
    blocked[(height - 1) * width + x] = 1;
  }
  for (let y = 0; y < height; y += 1) {
    blocked[y * width] = 1;
    blocked[y * width + (width - 1)] = 1;
  }

  pairs.forEach(([pointA, pointB]) => {
    const x0 = pointA.nx * (width - 1);
    const y0 = pointA.ny * (height - 1);
    const x1 = pointB.nx * (width - 1);
    const y1 = pointB.ny * (height - 1);
    drawBlockedLine(blocked, width, height, x0, y0, x1, y1);
  });

  const labels = new Int32Array(size).fill(-1);
  const areas = [];
  const floodQueue = new Int32Array(size);

  let regionId = 0;
  for (let i = 0; i < size; i += 1) {
    if (blocked[i] || labels[i] !== -1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    floodQueue[tail] = i;
    tail += 1;
    labels[i] = regionId;
    let area = 0;
    let touchesImageBorder = false;

    while (head < tail) {
      const current = floodQueue[head];
      head += 1;
      area += 1;

      const x = current % width;
      const y = (current - x) / width;

      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width
      ];

      if (x <= 1 || x >= width - 2 || y <= 1 || y >= height - 2) {
        touchesImageBorder = true;
      }

      if (x === 0) {
        neighbors[0] = -1;
      }
      if (x === width - 1) {
        neighbors[1] = -1;
      }
      if (y === 0) {
        neighbors[2] = -1;
      }
      if (y === height - 1) {
        neighbors[3] = -1;
      }

      for (let n = 0; n < neighbors.length; n += 1) {
        const next = neighbors[n];
        if (next < 0 || blocked[next] || labels[next] !== -1) {
          continue;
        }
        labels[next] = regionId;
        floodQueue[tail] = next;
        tail += 1;
      }
    }

    areas.push({ id: regionId, area, touchesImageBorder });
    regionId += 1;
  }

  const internalAreas = areas.filter((item) => !item.touchesImageBorder);

  if (!internalAreas.length) {
    return null;
  }

  const sorted = [...internalAreas].sort((a, b) => a.area - b.area);
  const sampleCount = Math.min(16, sorted.length);
  const sample = sorted.slice(0, sampleCount);
  const averageArea = sample.reduce((sum, item) => sum + item.area, 0) / sampleCount;
  const tolerance = Math.max(2, averageArea * AREA_MATCH_TOLERANCE);

  const accepted = new Set(
    internalAreas
      .filter((item) => Math.abs(item.area - averageArea) <= tolerance)
      .map((item) => item.id)
  );

  if (!accepted.size) {
    return null;
  }

  const partMask = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const label = labels[i];
    if (label >= 0 && accepted.has(label)) {
      partMask[i] = 1;
    }
  }

  const mergedSourceMask = dilateMask(partMask, width, height, REGION_MERGE_RADIUS);

  const mergedMask = new Uint8Array(size);
  const mergeQueue = new Int32Array(size);
  const visited = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    if (!mergedSourceMask[i] || visited[i]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    mergeQueue[tail] = i;
    tail += 1;
    visited[i] = 1;

    while (head < tail) {
      const current = mergeQueue[head];
      head += 1;
      mergedMask[current] = 1;

      const x = current % width;
      const y = (current - x) / width;

      for (let ny = y - 1; ny <= y + 1; ny += 1) {
        if (ny < 0 || ny >= height) {
          continue;
        }

        for (let nx = x - 1; nx <= x + 1; nx += 1) {
          if (nx < 0 || nx >= width) {
            continue;
          }

          const next = ny * width + nx;
          if (!visited[next] && mergedSourceMask[next]) {
            visited[next] = 1;
            mergeQueue[tail] = next;
            tail += 1;
          }
        }
      }
    }
  }

  const structureLabels = new Int32Array(size).fill(-1);
  const structureQueue = new Int32Array(size);
  const structures = [];
  let structureId = 0;

  for (let i = 0; i < size; i += 1) {
    if (!mergedMask[i] || structureLabels[i] !== -1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    structureQueue[tail] = i;
    tail += 1;
    structureLabels[i] = structureId;

    const pieceIds = new Set();
    let minPartX = width - 1;
    let minPartY = height - 1;
    let maxPartX = 0;
    let maxPartY = 0;
    let hasPartPixel = false;

    while (head < tail) {
      const current = structureQueue[head];
      head += 1;

      const x = current % width;
      const y = (current - x) / width;

      if (partMask[current]) {
        hasPartPixel = true;
        minPartX = Math.min(minPartX, x);
        minPartY = Math.min(minPartY, y);
        maxPartX = Math.max(maxPartX, x);
        maxPartY = Math.max(maxPartY, y);

        const pieceId = labels[current];
        if (pieceId >= 0 && accepted.has(pieceId)) {
          pieceIds.add(pieceId);
        }
      }

      for (let ny = y - 1; ny <= y + 1; ny += 1) {
        if (ny < 0 || ny >= height) {
          continue;
        }

        for (let nx = x - 1; nx <= x + 1; nx += 1) {
          if (nx < 0 || nx >= width) {
            continue;
          }

          const next = ny * width + nx;
          if (mergedMask[next] && structureLabels[next] === -1) {
            structureLabels[next] = structureId;
            structureQueue[tail] = next;
            tail += 1;
          }
        }
      }
    }

    if (hasPartPixel && pieceIds.size === REQUIRED_PARTS_PER_STRUCTURE) {
      structures.push({
        id: structureId,
        left: minPartX,
        top: minPartY,
        right: maxPartX,
        bottom: maxPartY,
        partCount: pieceIds.size
      });
    }

    structureId += 1;
  }

  const debugMask = new Uint8Array(size);
  structures.forEach((structure) => {
    for (let y = structure.top; y <= structure.bottom; y += 1) {
      for (let x = structure.left; x <= structure.right; x += 1) {
        debugMask[y * width + x] = 1;
      }
    }
  });

  const alphaMask = new Uint8ClampedArray(size);
  for (let i = 0; i < size; i += 1) {
    if (debugMask[i]) {
      alphaMask[i] = 110;
    }
  }

  return {
    width,
    height,
    alphaMask,
    debugMask,
    structures,
    smallSquaresCount: structures.length * REQUIRED_PARTS_PER_STRUCTURE
  };
}

function paintRegionsOverlay(imageRect, zoneRect, pairs) {
  if (!imageRect || !pairs.length) {
    clearRegionsLayer();
    return null;
  }

  const mask = computeHighlightMask(imageRect, pairs);
  if (!mask) {
    clearRegionsLayer();
    return null;
  }

  const zoneLeft = imageRect.left - zoneRect.left;
  const zoneTop = imageRect.top - zoneRect.top;

  regionsLayer.innerHTML = '';
  regionsLayer.setAttribute('viewBox', `0 0 ${Math.max(1, zoneRect.width)} ${Math.max(1, zoneRect.height)}`);
  regionsLayer.setAttribute('width', `${zoneRect.width}`);
  regionsLayer.setAttribute('height', `${zoneRect.height}`);

  const debugMask = mask.debugMask || mask.partMask;
  const mw = mask.width;
  const mh = mask.height;

  for (let y = 0; y < mh; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= mw; x += 1) {
      const filled = x < mw ? debugMask[y * mw + x] : 0;

      if (filled && runStart < 0) {
        runStart = x;
        continue;
      }

      if (!filled && runStart >= 0) {
        const runEnd = x - 1;

        const left = zoneLeft + (runStart / mw) * imageRect.width;
        const right = zoneLeft + ((runEnd + 1) / mw) * imageRect.width;
        const top = zoneTop + (y / mh) * imageRect.height;
        const bottom = zoneTop + ((y + 1) / mh) * imageRect.height;

        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        poly.setAttribute('points', `${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`);
        poly.setAttribute('class', 'region-debug-poly');
        regionsLayer.appendChild(poly);

        runStart = -1;
      }
    }
  }

  return mask;
}

function renderSelectedCells(imageRect, zoneRect, mask) {
  cellsLayer.innerHTML = '';

  if (!imageRect || !detectedCells.length || !detectedImageWidth || !detectedImageHeight) {
    return 0;
  }

  cellsLayer.setAttribute('viewBox', `0 0 ${Math.max(1, zoneRect.width)} ${Math.max(1, zoneRect.height)}`);
  cellsLayer.setAttribute('width', `${zoneRect.width}`);
  cellsLayer.setAttribute('height', `${zoneRect.height}`);

  function getCellMaskHits(cx, cy) {
    if (!mask || !Array.isArray(mask.structures) || !mask.structures.length) {
      return {
        include: false
      };
    }

    const toMaskX = (x) => (clamp(x, 0, detectedImageWidth - 1) / Math.max(1, detectedImageWidth - 1)) * (mask.width - 1);
    const toMaskY = (y) => (clamp(y, 0, detectedImageHeight - 1) / Math.max(1, detectedImageHeight - 1)) * (mask.height - 1);

    const cellLeft = toMaskX(cx - CELL_HALF_SIZE);
    const cellRight = toMaskX(cx + CELL_HALF_SIZE);
    const cellTop = toMaskY(cy - CELL_HALF_SIZE);
    const cellBottom = toMaskY(cy + CELL_HALF_SIZE);
    const cellCenterX = toMaskX(cx);
    const cellCenterY = toMaskY(cy);

    for (let i = 0; i < mask.structures.length; i += 1) {
      const structure = mask.structures[i];

      const left = structure.left;
      const top = structure.top;
      const right = structure.right;
      const bottom = structure.bottom;

      const intersectsRect = !(cellRight < left || cellLeft > right || cellBottom < top || cellTop > bottom);
      if (!intersectsRect) {
        continue;
      }

      const centerInside = cellCenterX >= left && cellCenterX <= right && cellCenterY >= top && cellCenterY <= bottom;

      const overlapsVertically = cellBottom >= top && cellTop <= bottom;
      const overlapsHorizontally = cellRight >= left && cellLeft <= right;

      const touchesLeftEdge = overlapsVertically && cellLeft <= left && cellRight >= left;
      const touchesTopEdge = overlapsHorizontally && cellTop <= top && cellBottom >= top;
      const touchesRightEdge = overlapsVertically && cellLeft <= right && cellRight >= right;
      const touchesBottomEdge = overlapsHorizontally && cellTop <= bottom && cellBottom >= bottom;

      if (touchesRightEdge || touchesBottomEdge) {
        continue;
      }

      if (centerInside || touchesLeftEdge || touchesTopEdge) {
        return { include: true };
      }
    }

    return {
      include: false
    };
  }

  let selectedCount = 0;

  detectedCells.forEach(([cx, cy]) => {
    const hits = getCellMaskHits(cx, cy);

    if (!hits.include) {
      return;
    }

    const nx = cx / Math.max(1, detectedImageWidth - 1);
    const ny = cy / Math.max(1, detectedImageHeight - 1);

    const px = imageRect.left + nx * imageRect.width;
    const py = imageRect.top + ny * imageRect.height;
    const zonePoint = toDropzonePoint(px, py);

    const halfW = Math.max(2, (CELL_HALF_SIZE * imageRect.width) / Math.max(1, detectedImageWidth));
    const halfH = Math.max(2, (CELL_HALF_SIZE * imageRect.height) / Math.max(1, detectedImageHeight));

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', `${zonePoint.x - halfW}`);
    rect.setAttribute('y', `${zonePoint.y - halfH}`);
    rect.setAttribute('width', `${halfW * 2}`);
    rect.setAttribute('height', `${halfH * 2}`);
    rect.setAttribute('class', 'cell-mark');
    cellsLayer.appendChild(rect);
    selectedCount += 1;
  });

  return selectedCount;
}

function renderOverlay() {
  pointsLayer.innerHTML = '';
  linesLayer.innerHTML = '';

  const imageRect = getImageRect();
  if (!imageRect) {
    clearRegionsLayer();
    clearCellsLayer();
    return;
  }

  const zoneRect = getDropZoneRect();
  if (edgePoints.length === 0) {
    clearRegionsLayer();
    const selected = renderSelectedCells(imageRect, zoneRect, null);
    updateResultStats(selected, 0);
    return;
  }

  linesLayer.setAttribute('viewBox', `0 0 ${Math.max(1, zoneRect.width)} ${Math.max(1, zoneRect.height)}`);
  linesLayer.setAttribute('width', `${zoneRect.width}`);
  linesLayer.setAttribute('height', `${zoneRect.height}`);

  const projected = edgePoints.map((point) => {
    const px = imageRect.left + point.nx * (imageRect.width - 1);
    const py = imageRect.top + point.ny * (imageRect.height - 1);
    const zonePoint = toDropzonePoint(px, py);
    let sx = clamp(zonePoint.x, imageRect.left - zoneRect.left, imageRect.right - zoneRect.left);
    let sy = clamp(zonePoint.y, imageRect.top - zoneRect.top, imageRect.bottom - zoneRect.top);

    if (point.edge === 'left') {
      sx += POINT_VISUAL_INSET;
    } else if (point.edge === 'right') {
      sx -= POINT_VISUAL_INSET;
    } else if (point.edge === 'top') {
      sy += POINT_VISUAL_INSET;
    } else if (point.edge === 'bottom') {
      sy -= POINT_VISUAL_INSET;
    }

    return {
      ...point,
      sx,
      sy
    };
  });

  projected.forEach((point) => {
    const dot = document.createElement('div');
    dot.className = 'point-dot';
    dot.style.left = `${point.sx}px`;
    dot.style.top = `${point.sy}px`;
    pointsLayer.appendChild(dot);

    const handle = document.createElement('div');
    handle.className = 'point-handle';
    handle.dataset.pointId = `${point.id}`;

    if (point.edge === 'left') {
      handle.style.width = '42px';
      handle.style.height = '12px';
      handle.style.left = `${point.sx - 42}px`;
      handle.style.top = `${point.sy - 6}px`;
    } else if (point.edge === 'right') {
      handle.style.width = '42px';
      handle.style.height = '12px';
      handle.style.left = `${point.sx}px`;
      handle.style.top = `${point.sy - 6}px`;
    } else if (point.edge === 'top') {
      handle.style.width = '12px';
      handle.style.height = '42px';
      handle.style.left = `${point.sx - 6}px`;
      handle.style.top = `${point.sy - 42}px`;
    } else {
      handle.style.width = '12px';
      handle.style.height = '42px';
      handle.style.left = `${point.sx - 6}px`;
      handle.style.top = `${point.sy}px`;
    }

    pointsLayer.appendChild(handle);
  });

  const pairs = [];
  const seen = new Set();

  function collectNearestPairs(edgeA, edgeB) {
    const groupA = projected.filter((p) => p.edge === edgeA);
    const groupB = projected.filter((p) => p.edge === edgeB);
    if (!groupA.length || !groupB.length) {
      return;
    }

    function addPair(fromPoint) {
      let bestPoint = null;
      let bestDistance = Infinity;

      groupB.forEach((candidate) => {
        const distance = Math.hypot(fromPoint.sx - candidate.sx, fromPoint.sy - candidate.sy);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPoint = candidate;
        }
      });

      if (!bestPoint) {
        return;
      }

      const key = fromPoint.id < bestPoint.id
        ? `${fromPoint.id}-${bestPoint.id}`
        : `${bestPoint.id}-${fromPoint.id}`;

      if (!seen.has(key)) {
        seen.add(key);
        pairs.push([fromPoint, bestPoint]);
      }
    }

    groupA.forEach(addPair);
    groupB.forEach((fromPoint) => {
      let bestPoint = null;
      let bestDistance = Infinity;

      groupA.forEach((candidate) => {
        const distance = Math.hypot(fromPoint.sx - candidate.sx, fromPoint.sy - candidate.sy);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPoint = candidate;
        }
      });

      if (!bestPoint) {
        return;
      }

      const key = fromPoint.id < bestPoint.id
        ? `${fromPoint.id}-${bestPoint.id}`
        : `${bestPoint.id}-${fromPoint.id}`;

      if (!seen.has(key)) {
        seen.add(key);
        pairs.push([fromPoint, bestPoint]);
      }
    });
  }

  collectNearestPairs('left', 'right');
  collectNearestPairs('top', 'bottom');

  pairs.forEach(([pointA, pointB]) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', `${pointA.sx}`);
    line.setAttribute('y1', `${pointA.sy}`);
    line.setAttribute('x2', `${pointB.sx}`);
    line.setAttribute('y2', `${pointB.sy}`);
    line.setAttribute('stroke', '#d63d3d');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'round');
    linesLayer.appendChild(line);
  });

  const mask = paintRegionsOverlay(imageRect, zoneRect, pairs);
  const selected = renderSelectedCells(imageRect, zoneRect, mask);
  updateResultStats(selected, mask ? mask.smallSquaresCount : 0);
}

function addEdgePointFromClick(clientX, clientY) {
  const imageRect = getImageRect();
  if (!imageRect) {
    return false;
  }

  if (
    clientX < imageRect.left ||
    clientX > imageRect.right ||
    clientY < imageRect.top ||
    clientY > imageRect.bottom
  ) {
    return false;
  }

  const nearestX = clientX;
  const nearestY = clientY;

  const leftDistance = Math.abs(nearestX - imageRect.left);
  const rightDistance = Math.abs(imageRect.right - nearestX);
  const topDistance = Math.abs(nearestY - imageRect.top);
  const bottomDistance = Math.abs(imageRect.bottom - nearestY);

  const normLeft = leftDistance / Math.max(1, imageRect.width);
  const normRight = rightDistance / Math.max(1, imageRect.width);
  const normTop = topDistance / Math.max(1, imageRect.height);
  const normBottom = bottomDistance / Math.max(1, imageRect.height);

  const nearest = [
    { edge: 'left', distance: leftDistance, normDistance: normLeft },
    { edge: 'right', distance: rightDistance, normDistance: normRight },
    { edge: 'top', distance: topDistance, normDistance: normTop },
    { edge: 'bottom', distance: bottomDistance, normDistance: normBottom }
  ].sort((a, b) => a.normDistance - b.normDistance)[0];

  if (!nearest) {
    return false;
  }

  if (nearest.distance > EDGE_SNAP_DISTANCE && nearest.normDistance > EDGE_SNAP_RATIO) {
    return false;
  }

  let nx = (nearestX - imageRect.left) / imageRect.width;
  let ny = (nearestY - imageRect.top) / imageRect.height;

  if (nearest.edge === 'left') {
    nx = 0;
  } else if (nearest.edge === 'right') {
    nx = 1;
  } else if (nearest.edge === 'top') {
    ny = 0;
  } else if (nearest.edge === 'bottom') {
    ny = 1;
  }

  nx = Math.min(1, Math.max(0, nx));
  ny = Math.min(1, Math.max(0, ny));

  edgePoints.push({
    id: ++pointCounter,
    edge: nearest.edge,
    nx,
    ny
  });

  undoPointButton.disabled = edgePoints.length === 0;
  renderOverlay();
  return true;
}

function dragEdgePoint(pointId, clientX, clientY) {
  const point = getEdgePointById(pointId);
  const imageRect = getImageRect();
  if (!point || !imageRect) {
    return;
  }

  const nx = (clientX - imageRect.left) / imageRect.width;
  const ny = (clientY - imageRect.top) / imageRect.height;

  if (point.edge === 'left' || point.edge === 'right') {
    point.ny = clamp(ny, 0, 1);
  } else {
    point.nx = clamp(nx, 0, 1);
  }

  renderOverlay();
}

function resetAppState() {
  isProcessed = false;
  selectedFile = null;
  fileInput.value = '';
  clearCurrentObjectUrl();
  clearDetectedCells();
  previewImage.style.display = 'none';
  previewImage.removeAttribute('src');
  dropPrompt.style.display = 'block';
  updateResultStats(0, 0);
  resetImageTransform();
  clearEdgePoints();
  setProcessMode();
}

function removeLastPoint() {
  if (!edgePoints.length) {
    return false;
  }

  edgePoints.pop();
  undoPointButton.disabled = edgePoints.length === 0;
  renderOverlay();
  return true;
}

function finishDragState() {
  if (dragMode === 'point-drag') {
    const activeHandle = pointsLayer.querySelector(`.point-handle[data-point-id="${activePointId}"]`);
    if (activeHandle) {
      activeHandle.classList.remove('dragging');
    }
  }

  dragMode = 'idle';
  activePointId = null;
  previewImage.classList.remove('grabbing');
}

menuButton.addEventListener('click', () => {
  const isOpen = sidebar.classList.contains('open');
  if (isOpen) {
    closeSidebar();
  } else {
    openSidebar();
  }
});

overlay.addEventListener('click', closeSidebar);

detectorButtons.forEach((button) => {
  button.addEventListener('click', () => {
    closeSidebar();
  });
});

document.addEventListener('click', (event) => {
  if (!sidebar.classList.contains('open')) {
    return;
  }

  const clickedInsideSidebar = sidebar.contains(event.target);
  const clickedMenuButton = menuButton.contains(event.target);
  if (!clickedInsideSidebar && !clickedMenuButton) {
    closeSidebar();
  }
});

function setPreview(file) {
  isProcessed = false;
  clearDetectedCells();
  updateResultStats(0, 0);
  selectedFile = file;
  if (!selectedFile) {
    clearCurrentObjectUrl();
    previewImage.style.display = 'none';
    previewImage.removeAttribute('src');
    dropPrompt.style.display = 'block';
    resetImageTransform();
    clearEdgePoints();
    setProcessMode();
    return;
  }

  clearCurrentObjectUrl();
  currentObjectUrl = URL.createObjectURL(selectedFile);
  previewImage.src = currentObjectUrl;
  previewImage.style.display = 'block';
  dropPrompt.style.display = 'none';
  resetImageTransform();
  clearEdgePoints();
  setProcessMode();
}

function openFilePicker() {
  fileInput.value = '';
  fileInput.click();
}

window.addEventListener('pageshow', () => {
  fileInput.value = '';
  suppressNextClick = false;
  dragMode = 'idle';
});

dropZone.addEventListener('click', (event) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    event.preventDefault();
    return;
  }

  if (!selectedFile && !isProcessed) {
    openFilePicker();
  }
});

dropZone.addEventListener('mousedown', (event) => {
  if (event.button !== 0) {
    return;
  }

  if (!isPreviewVisible()) {
    return;
  }

  const handle = event.target.closest('.point-handle');
  suppressNextClick = false;

  pointerStartX = event.clientX;
  pointerStartY = event.clientY;
  initialPanX = panX;
  initialPanY = panY;
  pointerMovedDistance = 0;

  if (handle) {
    activePointId = Number(handle.dataset.pointId);
    dragMode = 'point-drag';
    handle.classList.add('dragging');
    event.preventDefault();
    return;
  }

  dragMode = 'pan-candidate';
  previewImage.classList.add('grabbing');
  event.preventDefault();
});

undoPointButton.addEventListener('click', () => {
  removeLastPoint();
});

window.addEventListener('keydown', (event) => {
  const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z';
  if (!isUndo) {
    return;
  }

  if (removeLastPoint()) {
    event.preventDefault();
  }
});

fileInput.addEventListener('change', (event) => {
  const [file] = event.target.files;
  setPreview(file || null);
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');

  const [file] = event.dataTransfer.files;
  if (!file || !file.type.startsWith('image/')) {
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  fileInput.files = dataTransfer.files;
  setPreview(file);
});

function startProgress() {
  let current = 5;
  progressContainer.hidden = false;
  progressBar.style.width = `${current}%`;

  progressTimer = window.setInterval(() => {
    if (current >= 90) {
      return;
    }
    current += Math.random() * 10;
    progressBar.style.width = `${Math.min(current, 90)}%`;
  }, 180);
}

function stopProgress(success = true) {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
  progressBar.style.width = success ? '100%' : '0%';
}

processButton.addEventListener('click', async () => {
  if (isProcessed) {
    resetAppState();
    return;
  }

  if (!selectedFile) {
    return;
  }

  processButton.disabled = true;
  startProgress();

  const formData = new FormData();
  formData.append('image', selectedFile);

  try {
    const response = await fetch('/process', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Ошибка обработки');
    }

    stopProgress(true);
    clearCurrentObjectUrl();
    previewImage.src = data.resultImageData || '';
    previewImage.style.display = 'block';
    dropPrompt.style.display = 'none';
    detectedCells = Array.isArray(data.cells) ? data.cells : [];
    detectedImageWidth = Number(data.imageWidth) || 0;
    detectedImageHeight = Number(data.imageHeight) || 0;
    resetImageTransform();
    isProcessed = true;
    renderOverlay();
    setDeleteMode();
  } catch (error) {
    stopProgress(false);
    if (error instanceof TypeError) {
      alert('Нет соединения с сервером. Запусти приложение командой: .venv/bin/python main.py');
    } else {
      alert(error.message || 'Не удалось обработать изображение');
    }
  } finally {
    window.setTimeout(() => {
      progressContainer.hidden = true;
      progressBar.style.width = '0%';
      if (!isProcessed) {
        setProcessMode();
      }
    }, 400);
  }
});

dropZone.addEventListener('wheel', (event) => {
  if (!isPreviewVisible()) {
    return;
  }

  event.preventDefault();
  const delta = event.deltaY < 0 ? 0.15 : -0.15;
  zoom = Math.min(5, Math.max(1, zoom + delta));

  if (zoom === 1) {
    panX = 0;
    panY = 0;
  }

  applyImageTransform();
}, { passive: false });

window.addEventListener('mousemove', (event) => {
  if (dragMode === 'idle') {
    return;
  }

  if (event.buttons === 0) {
    finishDragState();
    suppressNextClick = true;
    return;
  }

  pointerMovedDistance = Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY);

  if (dragMode === 'point-drag') {
    dragEdgePoint(activePointId, event.clientX, event.clientY);
    return;
  }

  if (dragMode === 'pan-candidate') {
    if (pointerMovedDistance > PAN_START_THRESHOLD) {
      dragMode = 'panning';
    }
  }

  if (dragMode !== 'panning') {
    return;
  }

  panX = initialPanX + (event.clientX - pointerStartX);
  panY = initialPanY + (event.clientY - pointerStartY);
  applyImageTransform();
});

window.addEventListener('mouseup', (event) => {
  if (dragMode === 'idle') {
    return;
  }

  if (dragMode === 'point-drag') {
    suppressNextClick = true;
  } else if (dragMode === 'pan-candidate' || (dragMode === 'panning' && pointerMovedDistance <= PAN_START_THRESHOLD * 1.4)) {
    const created = addEdgePointFromClick(pointerStartX, pointerStartY);
    suppressNextClick = created;
  } else {
    suppressNextClick = true;
  }

  finishDragState();
});

window.addEventListener('blur', () => {
  if (dragMode !== 'idle') {
    finishDragState();
  }
});

previewImage.addEventListener('load', () => {
  renderOverlay();
});

window.addEventListener('resize', () => {
  renderOverlay();
});
