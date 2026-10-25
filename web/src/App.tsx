import { lazy, Suspense, useEffect, useState } from 'react';
import { Landing } from './Landing';

const Companion = lazy(() => import('./companion/Companion').then((m) => ({ default: m.Companion })));
const Family = lazy(() => import('./family/Family').then((m) => ({ default: m.Family })));
const Join = lazy(() => import('./family/Join').then((m) => ({ default: m.Join })));

function useHashRoute() {
  const [hash, setHash] = useState(() => location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const path = hash.replace(/^#/, '').split('?')[0];
  return (
    <Suspense fallback={null}>
      {path.startsWith('/companion') ? <Companion /> : path.startsWith('/join') ? <Join /> : path.startsWith('/family') ? <Family path={path} /> : <Landing />}
    </Suspense>
  );
}
