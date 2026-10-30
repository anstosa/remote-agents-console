import { Skeleton } from '../skeleton.js';
import './loading.css';

type CodeLoadingKind = 'diff' | 'file' | 'image';
export type CodeLoadingImageSides = 'before' | 'after' | 'both';

const rasterPath = /\.(?:gif|jpe?g|png|webp)$/iu;
const lineWidths = ['84%', '61%', '73%', '46%', '78%', '57%', '68%'];

// render varied source lines without loading the diff renderer
function CodeLines({ count = lineWidths.length }: { count?: number }) {
  return <div className="code-loading-lines" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <Skeleton key={index} className="code-loading-line" style={{ width: lineWidths[index % lineWidths.length] }} />)}
  </div>;
}

// mirror one changed file header and its visible hunk
function DiffBlock({ short = false }: { short?: boolean }) {
  return <section className="code-loading-diff-block" aria-hidden="true">
    <div className="code-loading-diff-header">
      <Skeleton className="code-loading-file-icon" />
      <Skeleton className="code-loading-file-name" />
      <Skeleton className="code-loading-file-stat" />
    </div>
    <Skeleton className="code-loading-hunk" />
    <CodeLines count={short ? 4 : 7} />
  </section>;
}

// compose the changed-file rail and multiple diff hunks
function DiffLoading() {
  return <div className="code-loading-diff">
    <aside className="code-loading-rail" aria-hidden="true">
      <Skeleton className="code-loading-rail-title" />
      {/* vary path widths like a real changed-file list */}
      {[72, 88, 64, 79, 58].map(width => <Skeleton key={width} className="code-loading-rail-row" style={{ width: `${width}%` }} />)}
    </aside>
    <div className="code-loading-diff-content">
      <DiffBlock />
      <DiffBlock short />
    </div>
  </div>;
}

// compose one plain source file without importing the syntax highlighter
function FileLoading({ path }: { path?: string }) {
  return <div className="code-loading-file">
    <div className="code-loading-file-header" aria-hidden="true">
      <Skeleton className="code-loading-file-icon" />
      <Skeleton className="code-loading-file-path" style={{ width: path === undefined ? '38%' : `${Math.min(74, Math.max(28, path.length * 2))}%` }} />
    </div>
    <CodeLines count={10} />
  </div>;
}

// compose one raster preview card and its metadata
function ImageCard({ label }: { label?: 'Before' | 'After' }) {
  return <figure className="code-loading-image-card">
    <figcaption>
      {label !== undefined && <strong>{label}</strong>}
      <Skeleton className="code-loading-image-path" />
    </figcaption>
    <Skeleton className="code-loading-image-canvas" />
    <div className="code-loading-image-meta">
      <Skeleton />
      <Skeleton />
    </div>
  </figure>;
}

// show a standalone raster or the expected sides of an image comparison
function ImageLoading({ comparison, sides }: { comparison: boolean; sides: CodeLoadingImageSides }) {
  return <div className={`code-loading-images${comparison && sides === 'both' ? ' comparison' : ''}`}>
    {comparison ? <>
      {/* retain only revisions the change status can contain */}
      {sides !== 'after' && <ImageCard label="Before" />}
      {sides !== 'before' && <ImageCard label="After" />}
    </> : <ImageCard />}
  </div>;
}

// expose semantic loading geometry for eager and in-panel Code loads
export function CodeLoading({ kind = 'diff', path, imageSides = 'both' }: { kind?: CodeLoadingKind; path?: string; imageSides?: CodeLoadingImageSides }) {
  // infer raster geometry for a file preview from its exact path only
  const fileIsImage = kind === 'file' && path !== undefined && rasterPath.test(path);
  const label = kind === 'diff' ? 'Loading changes' : kind === 'image' || fileIsImage ? 'Loading image' : 'Loading file';
  return <div className={`code-loading code-loading-${fileIsImage ? 'image' : kind}`} role="status" aria-busy="true" aria-label={label}>
    <span className="sr-only">{label}…</span>
    {kind === 'diff' ? <DiffLoading /> : kind === 'image' || fileIsImage ? <ImageLoading comparison={kind === 'image'} sides={imageSides} /> : <FileLoading path={path} />}
  </div>;
}
