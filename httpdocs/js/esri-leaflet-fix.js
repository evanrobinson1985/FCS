/*
 * Works around a bug in esri-leaflet's image layers (the Interactive Map's contour lines and slope).
 *
 * Each time the map moves, such a layer starts loading a new image from the server. If the layer is
 * switched off while an image is still loading, esri-leaflet doesn't cancel it:
 *   - if that image then fails to load, its error handler calls removeLayer() on the map the layer no
 *     longer has, throwing "Cannot read properties of null (reading 'removeLayer')";
 *   - if it loads, it stays on the map for good, invisible.
 * (Present in 3.0.10, which this site uses, and still in 3.0.19, the latest release.)
 *
 * This keeps a list of each layer's images that are still loading, and when the layer is removed from
 * the map, drops their load/error handlers and takes them off the map. Must load after esri-leaflet.
 */
(function () {
  'use strict';
  if (typeof L === 'undefined' || !L.esri || !L.esri.RasterLayer || !L.ImageOverlay) return;
  const proto = L.esri.RasterLayer.prototype;
  if (proto._fcsPendingFix) return;
  proto._fcsPendingFix = true;

  const renderImage = proto._renderImage;
  proto._renderImage = function () {
    const map = this._map;
    if (!map) return undefined;
    // esri-leaflet adds the new image to the map inside _renderImage; catch it as it's added
    let added = null;
    const grab = (e) => { if (e.layer instanceof L.ImageOverlay) added = e.layer; };
    map.on('layeradd', grab);
    let result;
    try { result = renderImage.apply(this, arguments); } finally { map.off('layeradd', grab); }
    if (added) {
      const pending = this._fcsPending || (this._fcsPending = new Set());
      pending.add(added);
      const done = () => pending.delete(added);
      added.once('load', done);
      added.once('error', done);
    }
    return result;
  };

  const onRemove = proto.onRemove;
  proto.onRemove = function (map) {
    const result = onRemove.apply(this, arguments);
    if (this._fcsPending) {
      for (const image of this._fcsPending) {
        image.off('load');
        image.off('error');
        if (image._map) image._map.removeLayer(image);
      }
      this._fcsPending.clear();
    }
    return result;
  };
})();
