import { useState } from 'react';
import { MCAPSheet } from './components/MCAPSheet';

function App() {
  const [url, setUrl] = useState('');

  return (
    <main style={{ display: 'grid', gap: 12, padding: 20, maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ margin: 0, fontSize: 28 }}>MCAP Sheets Viewer</h1>
      <label htmlFor="mcap-url">MCAP URL</label>
      <input
        id="mcap-url"
        type="url"
        value={url}
        placeholder="https://example.com/file.mcap"
        onChange={(event) => setUrl(event.target.value)}
      />
      {url ? <MCAPSheet url={url} /> : <p>Paste an MCAP URL to begin.</p>}
    </main>
  );
}

export default App;
