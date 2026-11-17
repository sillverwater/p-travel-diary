export function placeUrl(query) {
  return `/api/maps/place?${new URLSearchParams({ query })}`;
}
export function routeUrl(origin, destination, mode) {
  return `/api/maps/route?${new URLSearchParams({ origin, destination, mode })}`;
}
