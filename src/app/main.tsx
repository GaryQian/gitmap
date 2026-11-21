// Entry of the React shell. Package 1H owns src/app.
import { createRoot } from 'react-dom/client';
import { config } from '../config';

document.title = config.app.title;
createRoot(document.getElementById('root')!).render(<div style={{ color: '#EDEFF2', padding: 24 }}>{config.app.title}</div>);
