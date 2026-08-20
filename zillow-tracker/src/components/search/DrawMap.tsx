'use client';

import { useEffect } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

/**
 * This whole module touches `window` (Leaflet reads it at import time), so it must only
 * ever be loaded client-side via `next/dynamic({ ssr: false })` — see SearchForm.tsx.
 */

type Ring = Array<[number, number]>;

function extractRing(layer: L.Polygon): Ring {
  const rings = layer.getLatLngs() as L.LatLng[][];
  const first = rings[0] ?? [];
  // GeoJSON order: [lng, lat], to match SearchLocation's `ring`.
  return first.map((p) => [p.lng, p.lat]);
}

function DrawControls({ onRingChange }: { onRingChange: (ring: Ring | null) => void }) {
  const map = useMap();

  useEffect(() => {
    map.pm.addControls({
      position: 'topleft',
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawCircle: false,
      drawText: false,
      drawPolygon: true,
      editMode: true,
      dragMode: false,
      cutPolygon: false,
      removalMode: true,
    });
    map.pm.setGlobalOptions({ allowSelfIntersection: false });

    function handleCreate(e: { layer: L.Layer }) {
      // Geoman draws one shape at a time here; a second polygon replaces the first
      // rather than silently accumulating shapes a "search inside this area" query has
      // no way to combine.
      map.eachLayer((l) => {
        if (l !== e.layer && l instanceof L.Polygon) map.removeLayer(l);
      });
      const layer = e.layer as L.Polygon;
      onRingChange(extractRing(layer));
      layer.on('pm:edit', () => onRingChange(extractRing(layer)));
    }
    function handleRemove() {
      onRingChange(null);
    }

    map.on('pm:create', handleCreate);
    map.on('pm:remove', handleRemove);
    return () => {
      map.off('pm:create', handleCreate);
      map.off('pm:remove', handleRemove);
    };
  }, [map, onRingChange]);

  return null;
}

export default function DrawMap({ onRingChange }: { onRingChange: (ring: Ring | null) => void }) {
  return (
    <div style={{ height: 360, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
      <MapContainer center={[39.8283, -98.5795]} zoom={4} style={{ height: '100%', width: '100%' }}>
        {/*
          CARTO's basemap, not tile.openstreetmap.org: OSM's tile usage policy explicitly
          discourages application traffic against that endpoint, and CARTO's free tier
          exists for exactly this use.
        */}
        <TileLayer
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        <DrawControls onRingChange={onRingChange} />
      </MapContainer>
    </div>
  );
}
