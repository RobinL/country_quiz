// Compare the actual visible line segments, independent of off-screen path
// commands, ring starting points, or direction. D3's polygon paths use M/L/Z.
export function visibleSegments(path, width = 640, height = 640, matrix = [1, 0, 0, 1, 0, 0]) {
  const tokens = (path ?? '').match(/[MLZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  const result = []
  let previous = null
  let start = null

  function edge(a, b) {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    if (dx === 0 && dy === 0) return
    let low = 0
    let high = 1
    for (const [p, q] of [[-dx, a[0]], [dx, width - a[0]], [-dy, a[1]], [dy, height - a[1]]]) {
      if (!p) { if (q < 0) return; continue }
      const t = q / p
      if (p < 0) low = Math.max(low, t)
      else high = Math.min(high, t)
      if (low > high) return
    }
    if (high - low < 1e-12) return
    const from = [a[0] + dx * low, a[1] + dy * low].map(x => x.toFixed(6)).join(',')
    const to = [a[0] + dx * high, a[1] + dy * high].map(x => x.toFixed(6)).join(',')
    result.push([from, to].sort().join('/'))
  }

  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]
    if (command === 'Z') { edge(previous, start); previous = start; continue }
    if (command !== 'M' && command !== 'L') throw new Error(`Unsupported path command ${command}`)
    const x = +tokens[i++]
    const y = +tokens[i++]
    const point = [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
    if (command === 'M') start = point
    else edge(previous, point)
    previous = point
  }
  return result.sort()
}
