export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuViewport {
  width: number;
  height: number;
}

export function fitMenuToViewport(
  point: MenuPoint,
  menu: { width: number; height: number },
  viewport: MenuViewport,
  margin = 8,
): MenuPoint {
  const fitsRight = point.x + menu.width + margin <= viewport.width;
  const fitsBelow = point.y + menu.height + margin <= viewport.height;
  return {
    x: Math.max(margin, fitsRight ? point.x : point.x - menu.width),
    y: Math.max(margin, fitsBelow ? point.y : point.y - menu.height),
  };
}
