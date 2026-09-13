import { useCallback, useRef, useState } from 'react';
import { MCAPSheet } from './components/MCAPSheet';
import { openMcapWorkbookFromBlob } from './lib/mcap/mcapWorkbook';
import './App.css';

type Source =
  | { kind: 'none' }
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: File };

function App() {
  const [urlInput, setUrlInput] = useState('');
  const [source, setSource] = useState<Source>({ kind: 'none' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFromFile = useCallback((file: File) => {
    setSource({ kind: 'file', file });
  }, []);

  const submitUrl = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = urlInput.trim();
      if (trimmed) {
        setSource({ kind: 'url', url: trimmed });
      }
    },
    [urlInput],
  );

  return (
    <div className="app">
      <header className="app__bar">
        <h1 className="app__title">MCAP Sheets</h1>
        <form className="app__url-form" onSubmit={submitUrl}>
          <input
            className="app__url"
            type="url"
            value={urlInput}
            placeholder="https://example.com/file.mcap"
            aria-label="MCAP URL"
            onChange={(event) => setUrlInput(event.target.value)}
          />
          <button className="app__btn" type="submit" disabled={!urlInput.trim()}>
            Open URL
          </button>
        </form>
        <button
          className="app__btn app__btn--primary"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          Open file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mcap"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              openFromFile(file);
            }
            event.target.value = '';
          }}
        />
      </header>

      <div className="app__body">
        {source.kind === 'none' ? (
          <div className="app__empty">
            <p>Open a local <code>.mcap</code> file, or paste a URL to one.</p>
            <p className="app__hint">
              Files are read entirely in your browser — nothing is uploaded.
            </p>
          </div>
        ) : source.kind === 'file' ? (
          <MCAPSheet
            key={`file:${source.file.name}:${source.file.lastModified}`}
            fill
            url={source.file.name}
            workbookOpener={() => openMcapWorkbookFromBlob(source.file)}
          />
        ) : (
          <MCAPSheet key={`url:${source.url}`} fill url={source.url} />
        )}
      </div>
    </div>
  );
}

export default App;
