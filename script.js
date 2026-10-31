(function() {
  window.__TERMINAL_SCRIPT__ = "(" + (function() {
    function getFakeStorage() {
      const memStore = {};
      return {
        getItem: (k) => memStore[k] || null,
        setItem: (k, v) => { memStore[k] = String(v); },
        removeItem: (k) => { delete memStore[k]; },
        clear: () => { Object.keys(memStore).forEach(k => delete memStore[k]); },
        key: (i) => Object.keys(memStore)[i] || null,
        get length() { return Object.keys(memStore).length; }
      };
    }

    try { window.sessionStorage.getItem('test'); } 
    catch (e) { try { Object.defineProperty(window, 'sessionStorage', { value: getFakeStorage(), configurable: true }); } catch (err) {} }

    try { window.localStorage.getItem('test'); } 
    catch (e) { try { Object.defineProperty(window, 'localStorage', { value: getFakeStorage(), configurable: true }); } catch (err) {} }

    try {
      const savedHistory = localStorage.getItem('retro_console_history');
      window.__CONSOLE_HISTORY__ = savedHistory ? JSON.parse(savedHistory) : (window.__CONSOLE_HISTORY__ || []);
    } catch (e) {
      window.__CONSOLE_HISTORY__ = window.__CONSOLE_HISTORY__ || [];
    }

    let existing = document.getElementById('retro-console-root');
    if (existing) {
      const existingInput = document.getElementById('cmd');
      if (existingInput) existingInput.focus();
      return;
    }

    const CLIENT_LINES = 1285; 
    const WORKER_LINES = 175;
    const CURRENT_LINE_COUNT = CLIENT_LINES + WORKER_LINES;

    let container = document.createElement('div');
    container.id = 'retro-console-root';
    
    container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background-color: rgba(0, 0, 0, 0.4); 
      color: #00ff66;
      font-family: 'Courier New', Courier, monospace;
      font-size: 1rem;
      box-sizing: border-box;
      padding: 20px;
      overflow-y: auto;
      z-index: 999999;
      transition: background 0.5s, color 0.5s;
      text-align: left;
    `;

    container.innerHTML = `
      <div id="output" style="white-space: pre-wrap; margin-bottom: 10px; text-align: left;">&lt;Console&gt; In-page system initialized. Enter "help" for commands</div>
      <div class="input-line" style="display: flex; align-items: flex-start; margin-top: 10px; text-align: left;">
        <span class="prompt" style="margin-right: 10px; margin-top: 4px; font-weight: bold; flex-shrink: 0;">&lt;QWERTY&gt;</span>
        <textarea id="cmd" rows="1" autocomplete="off" spellcheck="false" autofocus style="background: transparent; border: none; color: inherit; font-family: 'Courier New', Courier, monospace; font-size: 1rem; outline: none; width: 100%; caret-color: inherit; resize: none; overflow: hidden; line-height: 1.2; text-align: left;"></textarea>
      </div>
    `;

    document.body.appendChild(container);

    const matrixCanvas = document.createElement('canvas');
    matrixCanvas.id = 'matrix-canvas';
    document.body.appendChild(matrixCanvas);

    const input = document.getElementById('cmd');
    const output = document.getElementById('output');
    let sessionStartTime = null;
    let commandLog = [];
    let archivedSessions = window.__CONSOLE_HISTORY__;
    let historyIndex = -1;
    const WORKER_URL = 'https://console-ai-js.qwerty12345-1o1.workers.dev';
    
    // Audio Setup
    const errorSound = new Audio('./error.mp3');
    errorSound.volume = 0.5;
    errorSound.preload = 'auto';
    let audioUnlocked = false;

    function playError() {
      if (audioUnlocked) {
        errorSound.currentTime = 0; 
        errorSound.play().catch(e => {});
      }
    }

    // Unlock audio on first keystroke
    input.addEventListener('input', function unlockAudio() {
      if (!audioUnlocked) {
        errorSound.play().then(() => {
          errorSound.pause();
          errorSound.currentTime = 0;
          audioUnlocked = true;
        }).catch(e => {});
      }
      input.removeEventListener('input', unlockAudio);
    });

    let currentMode = 'multi'; 
    let ollamaEnabled = false;
    let linuxWrapper = null; 
    let matrixInterval = null;

    let customCommands = {};
    try {
      customCommands = JSON.parse(localStorage.getItem('retro_custom_cmds') || '{}');
    } catch(e) {}

    const PROVIDER_COLORS = {
      'openai': '#4da6ff',
      'nvidia/nemotron-3.5-super-vl:free': '#ff6b6b',
      'recursive/flint-v1.0:free': '#a855f7',
      'ollama': '#ffd93d'
    };

    function autoResize() {
      input.style.height = 'auto';
      input.style.height = (input.scrollHeight) + 'px';
    }

    function scrollToBottom() {
      container.scrollTop = container.scrollHeight;
    }

    input.addEventListener('input', function() {
      autoResize();
      scrollToBottom();
    });

    function resetInput() {
      input.value = '';
      autoResize();
    }

    function writeLine(text) {
      const line = document.createElement('div');
      line.style.whiteSpace = 'pre-wrap';
      line.style.textAlign = 'left';
      line.textContent = text;
      output.appendChild(line);
      return line;
    }

    function clearOutput(initialText) {
      output.innerHTML = '';
      if (initialText) writeLine(initialText);
    }

    function highlightCode(code, lang) {
      if (typeof code !== 'string') return String(code);
      let escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      
      if (lang === 'js') {
        escaped = escaped.replace(/\b(let|const|var|function|return|if|else|for|while|class|new|import|export|from|try|catch|await|async|typeof|instanceof)\b/g, '<span style="color: #c678dd; font-weight: bold;">$1</span>');
        escaped = escaped.replace(/(['"`])(.*?)\1/g, '<span style="color: #98c379;">$1$2$1</span>');
        escaped = escaped.replace(/\b(\d+(\.\d+)?)\b/g, '<span style="color: #d19a66;">$1</span>');
        escaped = escaped.replace(/(\/\/.*)/g, '<span style="color: #5c6370; font-style: italic;">$1</span>');
      } else if (lang === 'py') {
        escaped = escaped.replace(/\b(def|return|if|elif|else|for|while|import|from|as|try|except|finally|with|class|print|in|is|not|and|or|True|False|None)\b/g, '<span style="color: #c678dd; font-weight: bold;">$1</span>');
        escaped = escaped.replace(/(['"])(.*?)\1/g, '<span style="color: #98c379;">$1$2$1</span>');
        escaped = escaped.replace(/(#.*)/g, '<span style="color: #5c6370; font-style: italic;">$1</span>');
      }
      return escaped;
    }

    function openFilePicker() {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '*/*';
      
      fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        writeLine(`<Console> [File Selected]: ${file.name}`);
        writeLine(`<Console> [Size]: ${(file.size / 1024).toFixed(2)} KB`);
        writeLine(`<Console> [Type]: ${file.type || 'Unknown'}`);

        if (file.type.startsWith('text/') || file.name.endsWith('.js') || file.name.endsWith('.py') || file.name.endsWith('.json') || file.name.endsWith('.md')) {
          const reader = new FileReader();
          reader.onload = (event) => {
            writeLine(`<Console> [Contents of ${file.name}]:\n`);
            writeLine(event.target.result);
            scrollToBottom();
          };
          reader.readAsText(file);
        } else {
          writeLine(`<Console> [Binary File Loaded. Displaying raw text is not supported for this type.]`);
        }
        scrollToBottom();
      };
      
      fileInput.click();
    }

    async function runLinux() {
      writeLine('<Console> [Downloading Linux Emulator...]');
      scrollToBottom();
      
      linuxWrapper = document.createElement('div');
      linuxWrapper.className = 'emulator-wrapper';
      linuxWrapper.tabIndex = 0; 
      
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 400;
      canvas.style.cssText = 'display: block;';
      
      linuxWrapper.appendChild(canvas);
      output.appendChild(linuxWrapper);
      
      setTimeout(() => linuxWrapper.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);

      try {
        if (!window.V86) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/v86@0.5.472/build/libv86.js';
            s.onload = resolve;
            s.onerror = () => reject(new Error("Failed to load v86 script"));
            document.head.appendChild(s);
          });
        }

        const emulator = new window.V86({
          wasm_path: 'https://cdn.jsdelivr.net/npm/v86@0.5.472/build/v86.wasm',
          memory_size: 64 * 1024 * 1024,
          vga_memory_size: 2 * 1024 * 1024,
          screen_container: linuxWrapper,
          bios: { url: 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin' },
          vga_bios: { url: 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin' },
          cdrom: { url: 'https://copy.sh/v86/images/linux.iso' },
          autostart: true,
        });

        writeLine('<Console> [Linux OS is booting... (It may take 10-30 seconds)]');
        writeLine('<Console> [Click on the black screen below to control the keyboard. Type "exit" to close it.]');
        scrollToBottom();
        
        linuxWrapper.addEventListener('click', (e) => {
          e.stopPropagation(); 
          linuxWrapper.focus();     
        });
        
      } catch (err) {
        playError();
        writeLine('<Console> [Emulator Error]: Failed to load v86. ' + err.message);
      }
    }

    function toggleMatrix() {
      if (matrixInterval) {
        clearInterval(matrixInterval);
        matrixInterval = null;
        matrixCanvas.style.display = 'none';
        return '<Console> Matrix mode disabled.';
      } else {
        matrixCanvas.style.display = 'block';
        const ctx = matrixCanvas.getContext('2d');
        
        const resizeCanvas = () => {
          matrixCanvas.width = window.innerWidth;
          matrixCanvas.height = window.innerHeight;
        };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
        const fontSize = 16;
        const columns = matrixCanvas.width / fontSize;
        const drops = Array(Math.floor(columns)).fill(1);

        matrixInterval = setInterval(() => {
          ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
          ctx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);
          ctx.fillStyle = "#00ff66";
          ctx.font = fontSize + "px monospace";

          for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
          ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * fontSize, drops[i] * fontSize);

            if (drops[i] * fontSize > matrixCanvas.height && Math.random() > 0.975) {
              drops[i] = 0;
            }
            drops[i]++;
          }
        }, 33);
        return '<Console> 🟩 MATRIX MODE ENGAGED 🟩 (Type "matrix" again to disable)';
      }
    }

    async function runTop() {
      writeLine('<Console> [Starting System Monitor...]');
      
      const topUI = document.createElement('div');
      topUI.style.cssText = 'border: 1px solid #00ff66; padding: 15px; margin-top: 10px; background: #050505; max-width: 500px; font-family: monospace; text-align: left;';
      topUI.innerHTML = `
        <div style="margin-bottom: 15px;">
          <strong>CPU Usage</strong> <br>
          <div class="bar-bg"><div id="cpu-bar" class="bar-fill"></div></div>
          <span id="cpu-text">0%</span>
        </div>
        <div style="margin-bottom: 15px;">
          <strong>Memory Usage</strong> <br>
          <div class="bar-bg"><div id="mem-bar" class="bar-fill"></div></div>
          <span id="mem-text">0 MB</span>
        </div>
        <div style="margin-bottom: 15px;">
          <strong>Battery</strong> <br>
          <div class="bar-bg"><div id="bat-bar" class="bar-fill" style="background:#ffd93d;"></div></div>
          <span id="bat-text">Unknown</span>
        </div>
        <button id="stop-top-btn" style="background: transparent; color: #ff6b6b; border: 1px solid #ff6b6b; padding: 5px 10px; cursor: pointer; margin-top: 10px;">✖ Stop Monitoring</button>
      `;
      output.appendChild(topUI);
      scrollToBottom();

      const cpuBar = document.getElementById('cpu-bar');
      const cpuText = document.getElementById('cpu-text');
      const memBar = document.getElementById('mem-bar');
      const memText = document.getElementById('mem-text');
      const batBar = document.getElementById('bat-bar');
      const batText = document.getElementById('bat-text');
      const stopBtn = document.getElementById('stop-top-btn');

      let lastTime = performance.now();
      let frames = 0;

      const cpuInterval = setInterval(() => {
        frames++;
        const now = performance.now();
        if (now - lastTime >= 1000) {
          const cpu = Math.min(100, Math.round((frames / ((now - lastTime) / 1000)) * 10)); 
          cpuBar.style.width = cpu + '%';
          cpuText.textContent = cpu + '%';
          frames = 0;
          lastTime = now;
        }

        if (performance.memory) {
          const used = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
          const total = Math.round(performance.memory.jsHeapSizeLimit / (1024 * 1024));
          const percent = Math.round((used / total) * 100);
          memBar.style.width = percent + '%';
          memText.textContent = `${used} MB / ${total} MB (${percent}%)`;
        } else {
          memText.textContent = "Not supported in this browser";
        }
      }, 1000);

      if (navigator.getBattery) {
        navigator.getBattery().then(battery => {
          const updateBat = () => {
            const level = Math.round(battery.level * 100);
            batBar.style.width = level + '%';
            batText.textContent = `${level}% ${battery.charging ? '(Charging)' : ''}`;
          };
          updateBat();
          battery.addEventListener('levelchange', updateBat);
          battery.addEventListener('chargingchange', updateBat);
        });
      }

      stopBtn.onclick = () => {
        clearInterval(cpuInterval);
        topUI.remove();
        writeLine('<Console> [System Monitor Stopped]');
        maintainFocus();
      };
    }

    function openSandbox() {
      writeLine('<Console> [Opening Code Sandbox...]');
      
      const windowFrame = document.createElement('div');
      windowFrame.style.cssText = `
        border: 2px solid #00ff66;
        margin-top: 10px;
        background: #050505;
        display: flex;
        flex-direction: column;
        box-shadow: 0 0 10px rgba(0, 255, 102, 0.2);
        max-width: 800px;
        text-align: left;
      `;

      const titleBar = document.createElement('div');
      titleBar.style.cssText = `
        background: #00ff66;
        color: #000;
        padding: 5px 10px;
        font-weight: bold;
        display: flex;
        justify-content: space-between;
        align-items: center;
      `;
      titleBar.innerHTML = `<span>Sandbox Editor v1.0</span>`;

      const toolbar = document.createElement('div');
      toolbar.style.cssText = `
        padding: 10px;
        display: flex;
        gap: 10px;
        border-bottom: 1px solid #222;
      `;

      const selector = document.createElement('select');
      selector.innerHTML = '<option value="js">JavaScript</option><option value="py">Python</option>';
      selector.style.cssText = 'background: #0d0d0d; color: #00ff66; border: 1px solid #00ff66; padding: 5px; font-family: monospace;';

      const runBtn = document.createElement('button');
      runBtn.textContent = '▶ Run Code';
      runBtn.style.cssText = 'background: #00ff66; color: #000; border: none; padding: 5px 15px; font-weight: bold; cursor: pointer; font-family: monospace;';

      const saveCmdBtn = document.createElement('button');
      saveCmdBtn.textContent = '💾 Save as Command';
      saveCmdBtn.style.cssText = 'background: #4da6ff; color: #000; border: none; padding: 5px 15px; font-weight: bold; cursor: pointer; font-family: monospace;';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✖ Close';
      closeBtn.style.cssText = 'background: transparent; color: #ff6b6b; border: 1px solid #ff6b6b; padding: 5px 15px; cursor: pointer; font-family: monospace; margin-left: auto;';

      toolbar.appendChild(selector);
      toolbar.appendChild(runBtn);
      toolbar.appendChild(saveCmdBtn);
      toolbar.appendChild(closeBtn);

      const editor = document.createElement('textarea');
      editor.className = 'sandbox-editor';
      editor.placeholder = '// Write your code here...';
      editor.value = 'console.log("Hello from the sandbox screen!");\nconsole.log("JS is running perfectly.");';

      const outputScreen = document.createElement('div');
      outputScreen.style.cssText = `
        background: #000;
        color: #00ff66;
        font-family: 'Courier New', Courier, monospace;
        font-size: 0.9rem;
        padding: 10px;
        min-height: 100px;
        max-height: 200px;
        overflow-y: auto;
        white-space: pre-wrap;
        text-align: left;
      `;
      outputScreen.textContent = '> Ready to execute.\n';

      windowFrame.appendChild(titleBar);
      windowFrame.appendChild(toolbar);
      windowFrame.appendChild(editor);
      windowFrame.appendChild(outputScreen);
      output.appendChild(windowFrame);
      scrollToBottom();

      selector.onchange = () => {
        if (selector.value === 'js') {
          editor.value = 'console.log("Hello from the sandbox screen!");\nconsole.log("JS is running perfectly.");';
        } else {
          editor.value = 'import sys\nprint("Hello from the sandbox screen!")\nprint("Python is running perfectly.")';
        }
      };

      closeBtn.onclick = () => windowFrame.remove();

      saveCmdBtn.onclick = () => {
        const cmdName = prompt("Enter a name for this custom command (e.g., 'greet'):");
        if (!cmdName) return;
        
        if (selector.value === 'py') {
          alert("Saving Python commands is not supported yet. Please use JavaScript.");
          return;
        }

        customCommands[cmdName.toLowerCase()] = editor.value;
        localStorage.setItem('retro_custom_cmds', JSON.stringify(customCommands));
        outputScreen.textContent += `\n> Saved custom command: "${cmdName.toLowerCase()}"\n`;
        writeLine(`<Console> [Sandbox] Custom command "${cmdName.toLowerCase()}" has been permanently saved.`);
        scrollToBottom();
      };

      runBtn.onclick = async () => {
        const code = editor.value.trim();
        const lang = selector.value;
        
        outputScreen.textContent += `\n> Executing ${lang.toUpperCase()}...\n`;
        outputScreen.scrollTop = outputScreen.scrollHeight;

        if (lang === 'js') {
          try {
            const originalLog = console.log;
            console.log = (...args) => {
              outputScreen.textContent += args.join(' ') + '\n';
            };

            const evalResult = (0, eval)(code);
            if (evalResult !== undefined) {
              outputScreen.textContent += '=> ' + String(evalResult) + '\n';
            }
            
            console.log = originalLog;
            outputScreen.textContent += '> Execution finished.\n';
          } catch (err) {
            playError();
            outputScreen.textContent += '[JS Error]: ' + err.message + '\n';
          }
        } else if (lang === 'py') {
          input.disabled = true;
          outputScreen.textContent += '> Booting Python engine...\n';
          
          try {
            const py = await getPyodide();
            let pyOutput = '';
            
            py.setStdout({ batched: (s) => { pyOutput += s + '\n'; } });
            py.setStderr({ batched: (s) => { pyOutput += '[stderr] ' + s + '\n'; } });
            
            let result = py.runPython(code);
            if (result !== undefined && result !== null) {
              pyOutput += '=> ' + String(result) + '\n';
            }
            
            outputScreen.textContent += pyOutput;
            outputScreen.textContent += '> Execution finished.\n';
          } catch (err) {
            playError();
            outputScreen.textContent += '[Python Error]: ' + err.message + '\n';
          }
          input.disabled = false;
          maintainFocus();
        }
        outputScreen.scrollTop = outputScreen.scrollHeight;
        scrollToBottom();
      };
    }

    async function fetchWeather(city) {
      try {
        const res = await fetch(`${WORKER_URL}/weather?city=${encodeURIComponent(city)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return `<Console> [Weather]: ${text.trim()}`;
      } catch (err) {
        playError();
        return `<Console> [Weather Error]: Could not fetch weather for "${city}". ${err.message}`;
      }
    }

    async function fetchDefinition(word) {
      try {
        const res = await fetch(`${WORKER_URL}/define?word=${encodeURIComponent(word)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
          const entry = data[0];
          const partOfSpeech = entry.meanings[0].partOfSpeech;
          const definition = entry.meanings[0].definitions[0].definition;
          return `<Console> [${entry.word}] (${partOfSpeech}):\n  ${definition}`;
        }
        playError();
        return `<Console> [Definition Error]: No definitions found for "${word}".`;
      } catch (err) {
        playError();
        return `<Console> [Definition Error]: Could not fetch definition for "${word}". ${err.message}`;
      }
    }

    const zoneList = [
      "Negative Offsets:",
      " - UTC-12:00 (Baker Island)", " - UTC-11:00 (Samoa)", " - UTC-10:00 (Hawaii)",
      " - UTC-09:30 (Marquesas)", " - UTC-09:00 (Alaska)", " - UTC-08:00 (PST)",
      " - UTC-07:00 (MST)", " - UTC-06:00 (CST)", " - UTC-05:00 (EST)",
      " - UTC-04:00 (AST)", " - UTC-03:30 (Newfoundland)", " - UTC-03:00 (Brazil/Arg)",
      " - UTC-02:00 (S. Georgia)", " - UTC-01:00 (Azores)", "",
      "Baseline:", " - UTC+00:00 (GMT/London)", "",
      "Positive Offsets:",
      " - UTC+01:00 (CET/Paris)", " - UTC+02:00 (EET/Athens)", " - UTC+03:00 (Moscow/Riyadh)",
      " - UTC+03:30 (Tehran)", " - UTC+04:00 (Dubai)", " - UTC+04:30 (Kabul)",
      " - UTC+05:00 (Karachi)", " - UTC+05:30 (India/IST)", " - UTC+05:45 (Kathmandu)",
      " - UTC+06:00 (Dhaka)", " - UTC+06:30 (Yangon)", " - UTC+07:00 (Bangkok)",
      " - UTC+08:00 (Singapore/Beijing)", " - UTC+08:45 (Eucla)", " - UTC+09:00 (Tokyo/Seoul)",
      " - UTC+09:30 (Adelaide)", " - UTC+10:00 (Sydney)", " - UTC+10:30 (Lord Howe)",
      " - UTC+11:00 (Solomon Islands)", " - UTC+12:00 (Auckland)", " - UTC+12:45 (Chatham)",
      " - UTC+13:00 (Tonga)", " - UTC+13:45 (Chatham DST)", " - UTC+14:00 (Kiritimati)"
    ];

    function parseOffsetTime(offsetStr) {
      let str = offsetStr.toUpperCase().replace('UTC', '').replace('GMT', '').trim();
      if (str === '' || str === '0' || str === '+0' || str === '-0' || str === '+00:00' || str === '00:00') {
        return new Date().toLocaleTimeString('en-US', { timeZone: 'UTC' });
      }
      let sign = 1;
      if (str.startsWith('-')) { sign = -1; str = str.substring(1); }
      else if (str.startsWith('+')) { str = str.substring(1); }

      let hours = 0, minutes = 0;
      if (str.includes(':')) {
        let parts = str.split(':');
        hours = parseInt(parts[0], 10) || 0;
        minutes = parseInt(parts[1], 10) || 0;
      } else if (str.includes('.')) {
        let val = parseFloat(str);
        hours = Math.floor(val);
        minutes = Math.round((val - hours) * 60);
      } else {
        hours = parseInt(str, 10) || 0;
      }

      let totalOffsetMinutes = sign * (hours * 60 + minutes);
      let now = new Date();
      let utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
      let targetDate = new Date(utcTime + (totalOffsetMinutes * 60000));
      return targetDate.toLocaleTimeString('en-US');
    }

    async function runInfo() {
      writeLine('<Console> [Gathering System & API Info...]');
      
      writeLine('\n--- [CLOUD APIS] ---');
      try {
        const res = await fetch(WORKER_URL, { method: 'GET' });
        if (res.ok) {
          const data = await res.json();
          writeLine(`Worker State: ${data.workerHealth} (HTTP ${res.status})`);
          writeLine(`OpenAI Key: ${data.providers.openai}`);
          writeLine(`OpenRouter Key: ${data.providers.openrouter}`);
        } else {
          playError();
          writeLine(`Worker Error: HTTP ${res.status}`);
        }
      } catch (err) {
        playError();
        writeLine(`Worker Error: Could not reach ${WORKER_URL}`);
      }

      writeLine('\n--- [LOCAL OLLAMA] ---');
      writeLine(`Ollama Enabled: ${ollamaEnabled ? 'YES' : 'NO'}`);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const res = await fetch('http://127.0.0.1:11434/', { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          writeLine('Ollama Engine: ACTIVE (127.0.0.1:11434)');
        } else {
          playError();
          writeLine(`Ollama Engine: ERROR (HTTP ${res.status})`);
        }
      } catch (err) {
        playError();
        writeLine('Ollama Engine: OFFLINE');
      }

      writeLine('\n--- [LOCAL ENGINES] ---');
      writeLine(`Python (Pyodide): ${pyodideInstance ? 'LOADED' : 'NOT LOADED'}`);
      try {
        localStorage.setItem('diag_test', '1');
        localStorage.removeItem('diag_test');
        writeLine(`LocalStorage: ACTIVE (Notes & History are saving)`);
      } catch (e) {
        writeLine(`LocalStorage: POLYFILLED (Notes & History are in-memory)`);
      }

      writeLine('\n--- [ENVIRONMENT] ---');
      writeLine(`Browser: ${navigator.userAgent.includes('Brave') ? 'Brave' : 'Chromium/Other'}`);
      writeLine(`User Agent: ${navigator.userAgent}`);
      writeLine(`OS (Platform): ${navigator.platform}`);
      writeLine(`Screen Resolution: ${window.screen.width}x${window.screen.height}`);
      writeLine(`Window Size: ${window.innerWidth}x${window.innerHeight}`);
      writeLine(`Window Size: ${window.innerWidth}x${window.innerHeight}`);
      writeLine(`CPU Cores: ${navigator.hardwareConcurrency || 'Unknown'}`);
      writeLine(`Device Memory: ${navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'Unknown'}`);
      
      if (navigator.getBattery) {
        try {
          const battery = await navigator.getBattery();
          writeLine(`Battery: ${Math.round(battery.level * 100)}% ${battery.charging ? '(Charging)' : '(Discharging)'}`);
        } catch (e) {
          writeLine(`Battery: Unavailable`);
        }
      } else {
        writeLine(`Battery: API not supported`);
      }

      writeLine('\n<Console> [Info Complete]');
      scrollToBottom();
    }

    async function fetchAIResponse(promptText) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); 
        const response = await fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ prompt: promptText }) });
        clearTimeout(timeoutId);
        const data = await response.json();
        if (response.ok && data.success) {
          return { success: true, responses: data.responses };
        } else {
          playError();
          return { success: false, error: data.error || "Unknown worker error" };
        }
      } catch (err) {
        playError();
        return { success: false, error: "Connection error: Could not reach Cloudflare Worker." };
      }
    }

    async function callOllama(promptText) {
      try {
        const ollamaController = new AbortController();
        const timeoutId = setTimeout(() => ollamaController.abort(), 90000);
        
        const res = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ollamaController.signal,
          body: JSON.stringify({
            model: 'llama3.2:3b',
            messages: [{ role: 'user', content: promptText }],
            stream: false
          })
        });
        clearTimeout(timeoutId);
        
        const data = await res.json();
        if (data && data.message && data.message.content) {
          return { success: true, text: data.message.content, provider: 'ollama' };
        }
        playError();
        return { success: false, error: 'Ollama returned an invalid response.' };
      } catch (err) {
        playError();
        if (err.name === 'AbortError') {
          return { success: false, error: 'Ollama took longer than 90 seconds and was stopped to free up your CPU.' };
        }
        return { success: false, error: 'Ollama connection failed. Is it running? Error: ' + err.message };
      }
    }

    let pyodideInstance = null;
    async function getPyodide() {
      if (pyodideInstance) return pyodideInstance;
      
      writeLine('<Console> [Downloading Python (Pyodide) engine. This happens only once...]');
      scrollToBottom();

      let loadPyodide;
      try {
        ({ loadPyodide } = await import('https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.mjs'));
      } catch (err) {
        playError();
        throw new Error("CDN import failed: " + err.message);
      }

      try {
        pyodideInstance = await loadPyodide({
          indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/'
        });
      } catch (err) {
        playError();
        throw new Error("Pyodide init failed: " + err.message);
      }
      
      writeLine('<Console> [Python engine ready.]');
      return pyodideInstance;
    }

    function maintainFocus() { if (!input.disabled) input.focus(); }
    setTimeout(maintainFocus, 100);
    
    container.addEventListener('click', (e) => {
      if (window.getSelection().toString().length > 0) return; 
      if (!e.target.classList.contains('inline-picker') && !e.target.closest('.sandbox-editor') && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON' && !e.target.closest('.emulator-wrapper')) {
        maintainFocus();
      }
    });

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandLog.length > 0 && historyIndex < commandLog.length - 1) {
          historyIndex++;
          input.value = commandLog[commandLog.length - 1 - historyIndex].cmd;
          autoResize();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex--;
          input.value = commandLog[commandLog.length - 1 - historyIndex].cmd;
          autoResize();
        } else if (historyIndex === 0) {
          historyIndex = -1;
          input.value = '';
          autoResize();
        }
        return;
      }

      if (e.key === 'Enter') {
        if (e.shiftKey) {
          setTimeout(autoResize, 10);
          return;
        }

        e.preventDefault();
        
        let fullInput = input.value.trim(); 
        if (fullInput === '') return;

        historyIndex = -1;
        let nowFormatted = new Date().toLocaleTimeString();
        if (!sessionStartTime) sessionStartTime = nowFormatted;

        commandLog.push({ cmd: fullInput, time: nowFormatted });
        writeLine('<QWERTY> ' + fullInput);

        if (fullInput.toLowerCase() === 'exit') {
          if (linuxWrapper) {
            linuxWrapper.remove();
            linuxWrapper = null;
            writeLine('<Console> [Linux emulator closed.]');
          } else {
            writeLine('<Console> [No emulator running.]');
          }
          resetInput();
          scrollToBottom();
          maintainFocus();
          return;
        }

        if (fullInput.toLowerCase().startsWith('js?')) {
          let jsCode = fullInput.substring(3).trim();
          writeLine('<Console> [Executing JS...]');
          resetInput();
          scrollToBottom();
          try {
            let evalResult = (0, eval)(jsCode);
            if (evalResult !== undefined) {
              let displayResult = typeof evalResult === 'object' ? JSON.stringify(evalResult, null, 2) : String(evalResult);
              const line = document.createElement('div');
              line.style.whiteSpace = 'pre-wrap';
              line.style.textAlign = 'left'; 
              line.innerHTML = '<span style="color: #00ff66;">&lt;Console&gt; [Result]:</span><br>' + highlightCode(String(evalResult), 'js');
              output.appendChild(line);
            } else {
              writeLine('<Console> [Result]: Executed successfully (no return value)');
            }
          } catch (err) {
            playError();
            writeLine('<Console> [JS Error]: ' + err.message);
          }
          scrollToBottom();
          maintainFocus();
          return;
        }

        if (fullInput.toLowerCase().startsWith('py?')) {
          let pyCode = fullInput.substring(3).trim();
          writeLine('<Console> [Executing Python...]');
          resetInput();
          input.disabled = true;
          scrollToBottom();

          try {
            const py = await getPyodide();
            let pyOutput = '';
            
            py.setStdout({ batched: (s) => { pyOutput += s + '\n'; } });
            py.setStderr({ batched: (s) => { pyOutput += '[stderr] ' + s + '\n'; } });

            let result = py.runPython(pyCode);
            
            if (result !== undefined && result !== null) {
              pyOutput += String(result);
            }
            
            const line = document.createElement('div');
            line.style.whiteSpace = 'pre-wrap';
            line.style.textAlign = 'left'; 
            line.innerHTML = '<span style="color: #00ff66;">&lt;Console&gt; [Result]:</span><br>' + highlightCode(pyOutput, 'py');
            output.appendChild(line);
          } catch (err) {
            playError();
            writeLine('<Console> [Python Error]: ' + err.message);
          }

          input.disabled = false;
          scrollToBottom();
          maintainFocus();
          return;
        }

        if (fullInput.startsWith('*') && fullInput.endsWith('*') && fullInput.length > 2) {
          let promptText = fullInput.substring(1, fullInput.length - 1).trim();
          writeLine('<Console> [Firing all cloud AIs in parallel...]');
          resetInput();
          input.disabled = true;
          scrollToBottom();

          let cloudResult = await fetchAIResponse(promptText);
          
          if (cloudResult.success && cloudResult.responses.length > 0) {
            if (currentMode === 'single') {
              const res = cloudResult.responses[0];
              const line = writeLine('<Console> [' + res.provider + ']\n' + res.text.trim() + '\n---');
              line.style.color = PROVIDER_COLORS[res.provider] || 'inherit';
            } else {
              cloudResult.responses.forEach(res => {
                const line = writeLine('<Console> [' + res.provider + ']\n' + res.text.trim() + '\n---');
                line.style.color = PROVIDER_COLORS[res.provider] || 'inherit';
              });
            }
          } else if (ollamaEnabled) {
            writeLine('<Console> [All cloud APIs failed. Trying local Ollama fallback...]');
            let ollamaResult = await callOllama(promptText);
            
            if (ollamaResult.success) {
              const line = writeLine('<Console> [ollama]\n' + ollamaResult.text.trim());
              line.style.color = PROVIDER_COLORS['ollama'];
            } else {
              writeLine('<Console> [Ollama Error]: ' + ollamaResult.error);
              if (cloudResult.error) writeLine('<Console> [Cloud Error]: ' + cloudResult.error);
            }
          } else {
            writeLine('<Console> [All cloud APIs failed.]');
            writeLine('<Console> [Ollama fallback is DISABLED. Type "ollama on" to enable local CPU generation.]');
            if (cloudResult.error) writeLine('<Console> [Cloud Error]: ' + cloudResult.error);
          }
          
          input.disabled = false;
          scrollToBottom();
          maintainFocus();
          return;
        }

        let parts = fullInput.split(' ');
        let cmdLower = parts[0].toLowerCase();
        let arg = parts.slice(1).join(' ');
        
        if (cmdLower === 'ranbow' || cmdLower === 'reinbow') cmdLower = 'rainbow';

        if (customCommands[cmdLower]) {
          resetInput();
          try {
            (0, eval)(customCommands[cmdLower]);
          } catch (err) {
            playError();
            writeLine('<Console> [Custom Cmd Error]: ' + err.message);
          }
          scrollToBottom();
          maintainFocus();
          return;
        }

        if (cmdLower.startsWith('utc') || cmdLower.startsWith('+') || cmdLower.startsWith('-')) {
          arg = fullInput;
          cmdLower = 'time';
        }

        let response = '';
        if (cmdLower === 'test') {
          resetInput();
          input.disabled = true;
          writeLine('<Console> [STARTING AUTOMATED TEST SEQUENCE...]');
          
          const simulateType = async (text) => {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
            input.dispatchEvent(event);
            await new Promise(r => setTimeout(r, 1000));
          };

          const tour = [
            "help", "credits", "lines", "zones", "time", "utc+5", 
            "ascii", "flip", "roll", "echo Auto-tour is running!", 
            "calc 5 * 5", "password 16",
            "note Auto-generated note", "notes", 
            "define hello", "weather London,UK",
            "js? const arr = [1,2,3,4,5]; arr.map(x => x * 10)", 
            "py? import math; print(math.factorial(15))", 
            "info", "mode single", "mode multi", "credits", "lines"
          ];

          for (let i = 0; i < tour.length; i++) {
            writeLine(`<Console> [Test Step ${i + 1}/${tour.length}]: Executing "${tour[i]}"`);
            await simulateType(tour[i]);
          }
          
          writeLine("<Console> [AUTO-TOUR COMPLETE]");
          input.disabled = false;
          maintainFocus();
          return;
        } else if (cmdLower === 'help') {
          response = '<Console> Available commands:\n' +
                     ' - help (shows this menu)\n' +
                     ' - test (runs the automated 20-step tour)\n' +
                     ' - zones (lists all timezone offsets)\n' +
                     ' - weather [city,country] (e.g. "weather London,UK")\n' +
                     ' - define [word] (looks up the definition of a word)\n' +
                     ' - calc [math] (e.g. "calc 5 * 5")\n' +
                     ' - password [length] (generates a secure random password)\n' +
                     ' - top (opens live system monitor)\n' +
                     ' - matrix (toggles falling code background)\n' +
                     ' - save (downloads terminal history to a text file)\n' +
                     ' - copy [text] (copies text to clipboard - SITE EXCLUSIVE)\n' +
                     ' - whereami (gets your GPS location - SITE EXCLUSIVE)\n' +
                     ' - share [text] (opens native OS share menu - SITE EXCLUSIVE)\n' +
                     ' - credits (shows project credits)\n' +
                     ' - clear (clears terminal & archives current session)\n' +
                     ' - history (views cleared sessions & timestamps)\n' +
                     ' - restore [id] (restores past session output)\n' +
                     ' - info (runs a full system check of APIs, engines, OS, and hardware)\n' +
                     ' - mode single / mode multi (toggle AI response behavior)\n' +
                     ' - ollama on / ollama off (toggle local CPU AI fallback)\n' +
                     ' - terminal (spawns another terminal inside this one)\n' +
                     ' - linux (boots a tiny Linux OS inside a canvas window)\n' +
                     ' - exit (closes the Linux emulator window)\n' +
                     ' - sandbox (opens a visual JS/Python playground)\n' +
                     ' - file (opens a file picker to load text/code into the terminal)\n' +
                     ' - note [text] (saves a persistent text note)\n' +
                     ' - notes (lists all saved notes)\n' +
                     ' - wipe (deletes all saved notes)\n' +
                     ' - picker (opens interactive text & background color pickers)\n' +
                     ' - theme [text_color] [bg_color] (changes console colors)\n' +
                     ' - rainbow (toggles full-screen rainbow mode)\n' +
                     ' - ascii (prints random ASCII art)\n' +
                     ' - flip (flips a coin)\n' +
                     ' - roll [sides] (rolls a die, defaults to 6 sides)\n' +
                     ' - echo [text] (prints text back)\n' +
                     ' - lines (shows total lines of console code)\n' +
                     ' - *[prompt]* (chat with AI by wrapping prompt in asterisks)\n' +
                     ' - JS? [code] (run live JavaScript directly in browser)\n' +
                     ' - PY? [code] (run live Python via Pyodide)\n' +
                     ' - [offset] (type any offset directly, e.g. UTC+02:00 or -5)';
        } else if (cmdLower === 'copy') {
          if (!arg) {
            response = '<Console> Usage: copy [text]';
          } else {
            navigator.clipboard.writeText(arg).then(() => {
              writeLine('<Console> [Clipboard] Copied to system clipboard!');
              scrollToBottom();
            }).catch(err => {
              playError();
              writeLine('<Console> [Clipboard Error] Could not copy. ' + err.message);
              scrollToBottom();
            });
            response = '';
          }
        } else if (cmdLower === 'whereami') {
          if (!navigator.geolocation) {
            playError();
            response = '<Console> Geolocation is not supported by this browser.';
          } else {
            resetInput();
            input.disabled = true;
            writeLine('<Console> [Requesting location...]');
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                writeLine(`<Console> [Location]: Lat ${pos.coords.latitude.toFixed(4)}, Lon ${pos.coords.longitude.toFixed(4)}`);
                input.disabled = false;
                maintainFocus();
                scrollToBottom();
              },
              (err) => {
                playError();
                writeLine(`<Console> [Geolocation Error]: ${err.message}`);
                input.disabled = false;
                maintainFocus();
                scrollToBottom();
              }
            );
            return;
          }
        } else if (cmdLower === 'share') {
          if (!arg) {
            response = '<Console> Usage: share [text]';
          } else if (navigator.share) {
            navigator.share({ text: arg }).then(() => {
              writeLine('<Console> [Share] Shared successfully!');
              scrollToBottom();
            }).catch(err => {
              playError();
              writeLine('<Console> [Share Error] Share cancelled or failed.');
              scrollToBottom();
            });
            response = '';
          } else {
            playError();
            response = '<Console> [Share Error] Native sharing is not supported on this device.';
          }
        } else if (cmdLower === 'save') {
          const blob = new Blob([output.textContent], {type: 'text/plain'});
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'terminal_history.txt';
          a.click();
          response = '<Console> [Saved] Terminal history downloaded as "terminal_history.txt".';
        } else if (cmdLower === 'matrix') {
          response = toggleMatrix();
        } else if (cmdLower === 'top') {
          resetInput();
          runTop();
          return;
        } else if (cmdLower === 'calc') {
          if (!arg) {
            response = '<Console> Usage: calc [math expression]';
          } else {
            try {
              const safeExpr = arg.replace(/[^0-9\+\-\*\/\.\(\)\s]/g, '');
              const result = (0, eval)(safeExpr);
              response = `<Console> [Calc]: ${safeExpr} = ${result}`;
            } catch (e) {
              playError();
              response = '<Console> [Calc Error]: Invalid math expression.';
            }
          }
        } else if (cmdLower === 'password') {
          const len = parseInt(arg) || 16;
          if (len > 128) { 
            playError();
            response = '<Console> Max password length is 128.'; 
          }
          else {
            const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
            let pass = "";
            for (let i = 0; i < len; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
            response = `<Console> [Password]: ${pass}`;
          }
        } else if (cmdLower === 'weather') {
          if (!arg) {
            response = '<Console> Usage: weather [city,country]';
          } else {
            resetInput();
            input.disabled = true;
            writeLine('<Console> [Fetching weather...]');
            response = await fetchWeather(arg);
            input.disabled = false;
            maintainFocus();
          }
        } else if (cmdLower === 'define') {
          if (!arg) {
            response = '<Console> Usage: define [word]';
          } else {
            resetInput();
            input.disabled = true;
            writeLine('<Console> [Fetching definition...]');
            response = await fetchDefinition(arg);
            input.disabled = false;
            maintainFocus();
          }
        } else if (cmdLower === 'mode') {
          if (arg === 'single' || arg === 'multi') {
            currentMode = arg;
            response = `<Console> AI Response Mode set to: ${currentMode.toUpperCase()}`;
          } else {
            response = `<Console> Current mode: ${currentMode.toUpperCase()}\nUsage: mode single OR mode multi`;
          }
        } else if (cmdLower === 'ollama') {
          if (arg === 'on') {
            ollamaEnabled = true;
            response = '<Console> Ollama fallback ENABLED. (Warning: Local CPU generation may lag your laptop).';
          } else if (arg === 'off') {
            ollamaEnabled = false;
            response = '<Console> Ollama fallback DISABLED. Terminal will rely only on cloud APIs.';
          } else {
            response = `<Console> Ollama fallback is currently: ${ollamaEnabled ? 'ENABLED' : 'DISABLED'}\nUsage: ollama on OR ollama off`;
          }
        } else if (cmdLower === 'terminal') {
          writeLine('<Console> [Spawning sub-terminal...]');
          resetInput();
          const script = document.createElement('script');
          script.textContent = window.__TERMINAL_SCRIPT__;
          document.body.appendChild(script);
          scrollToBottom();
          maintainFocus();
          return;
        } else if (cmdLower === 'zones') {
          response = '<Console> Available Offsets:\n' + zoneList.join('\n');
        } else if (cmdLower === 'file') {
          openFilePicker();
          resetInput();
          return;
        } else if (cmdLower === 'info') {
          resetInput();
          input.disabled = true;
          await runInfo();
          input.disabled = false;
          maintainFocus();
          return;
        } else if (cmdLower === 'linux') {
          resetInput();
          input.disabled = true;
          await runLinux();
          input.disabled = false;
          maintainFocus();
          return;
        } else if (cmdLower === 'sandbox') {
          resetInput();
          openSandbox();
          maintainFocus();
          return;
        } else if (cmdLower === 'note') {
          if (!arg) {
            response = '<Console> Usage: note [your text here]';
          } else {
            try {
              const notes = JSON.parse(localStorage.getItem('retro_notes') || '[]');
              notes.push({ time: nowFormatted, text: arg });
              localStorage.setItem('retro_notes', JSON.stringify(notes));
              response = `<Console> [Note Saved]: "${arg}"`;
            } catch (e) {
              playError();
              response = '<Console> [Error]: Could not save note (Storage full or blocked).';
            }
          }
        } else if (cmdLower === 'notes') {
          try {
            const notes = JSON.parse(localStorage.getItem('retro_notes') || '[]');
            if (notes.length === 0) {
              response = '<Console> No notes saved. Use "note [text]" to create one.';
            } else {
              let noteLines = ['<Console> Saved Notes:'];
              notes.forEach((n, i) => {
                noteLines.push(`  [${i + 1}] ${n.time} - ${n.text}`);
              });
              response = noteLines.join('\n');
            }
          } catch (e) {
            playError();
            response = '<Console> [Error]: Could not load notes.';
          }
        } else if (cmdLower === 'wipe') {
          try {
            localStorage.removeItem('retro_notes');
            response = '<Console> All saved notes have been wiped.';
          } catch (e) {
            playError();
            response = '<Console> [Error]: Could not wipe notes.';
          }
        } else if (cmdLower === 'rainbow') {
          if (container.classList.contains('rainbow-mode')) {
            container.classList.remove('rainbow-mode', 'rainbow-bg');
            container.style.color = '#00ff66';
            container.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            response = '<Console> Rainbow mode disabled.';
          } else {
            container.classList.add('rainbow-mode', 'rainbow-bg');
            response = '<Console> 🌈 RAINBOW MODE ENGAGED 🌈 (Type "rainbow" again to disable)';
          }
        } else if (cmdLower === 'ascii') {
          const art = [
            "  /\\_/\\  \n ( o.o ) \n  > ^ <  ",
            "  _____  \n |     | \n |_____| ",
            "   ___   \n  /___\\  \n  |___|  ",
            "  .---.  \n /     \\ \n \\     / \n  '---'  "
          ];
          response = art[Math.floor(Math.random() * art.length)];
        } else if (cmdLower === 'flip') {
          response = '<Console> 🪙 ' + (Math.random() < 0.5 ? 'HEADS' : 'TAILS');
        } else if (cmdLower === 'roll') {
          let sides = parseInt(arg);
          if (isNaN(sides) || sides < 2) {
            sides = 6;
          }
          const rollResult = Math.floor(Math.random() * sides) + 1;
          response = `<Console> 🎲 You rolled a d${sides} and got a ${rollResult}!`;
        } else if (cmdLower === 'echo') {
          response = arg || '<Console> (nothing to echo)';
        } else if (cmdLower === 'credits') {
          response = '<Console> Ideas for The Console and idea of The Console: QWERTY (also known as Mason, RTG elicit and Real Elicit)\n' +
                     'Coder: Gemini (made ~400 and fired because of usage limits and inefficiency) DeepSeek (fixed all of Gemini\'s lines of code and made better code) Brave Search Assistant (corrected few Gemini lines and DeepSeek lines of code)\n' +
                     'AI responses: Open ai/ChatGPT, Nemotron, Flint (via OpenRouter), and Ollama (local fallback)\n' +
                     'Coding Software: Cloudflare (' + WORKER_LINES + ' lines written within, makes api keys hidden and ai work!)\n' +
                     'Built-in client side browser console (' + CLIENT_LINES + ' lines, makes all the visuals and commands work)';
        } else if (cmdLower === 'lines') {
          response = '<Console> Source code lines:\n' +
                     ' - Client console: ' + CLIENT_LINES + ' lines\n' +
                     ' - Cloudflare Worker: ' + WORKER_LINES + ' lines\n' +
                     ' - Total: ' + CURRENT_LINE_COUNT + ' lines';
        } else if (cmdLower === 'clear') {
          if (commandLog.length > 0) {
            archivedSessions.push({
              id: archivedSessions.length + 1,
              start: sessionStartTime,
              end: nowFormatted,
              content: output.textContent, 
              commands: [...commandLog]
            });
            try {
              localStorage.setItem('retro_console_history', JSON.stringify(archivedSessions));
            } catch (e) {}
          }
          sessionStartTime = null;
          commandLog = [];
          historyIndex = -1;
          clearOutput('<Console> Terminal cleared. Type "history" to view archived session logs.');
          resetInput();
          maintainFocus();
          return;
        } else if (cmdLower === 'history') {
          if (archivedSessions.length === 0) {
            response = '<Console> No archived sessions. Clear the console to create a session entry.';
          } else {
            let historyLines = ['<Console> Archived Sessions:'];
            archivedSessions.forEach((sess) => {
              historyLines.push('  [' + sess.id + '] Started: ' + sess.start + ' | Cleared: ' + sess.end + ' (' + sess.commands.length + ' commands)');
            });
            historyLines.push('\nType "restore [id]" to reload a past console session.');
            response = historyLines.join('\n');
          }
        } else if (cmdLower === 'restore') {
          let targetId = parseInt(arg, 10);
          let foundSession = archivedSessions.find(s => s.id === targetId);
          if (foundSession) {
            clearOutput(foundSession.content);
            writeLine('<Console> [ Session #' + foundSession.id + ' restored. Resuming input... ]');
            sessionStartTime = foundSession.start;
            commandLog = [...foundSession.commands];
            historyIndex = -1;
            resetInput();
            scrollToBottom();
            maintainFocus();
            return;
          } else {
            playError();
            response = '<Console> Invalid session ID. Type "history" to view available session IDs.';
          }
        } else if (cmdLower === 'picker') {
          let textPickerId = 'tcp-' + Date.now();
          let bgPickerId = 'bgcp-' + Date.now();
          writeLine('<Console> Color Pickers Activated:');
          
          let pickerContainer = document.createElement('div');
          pickerContainer.className = 'picker-container';
          pickerContainer.innerHTML = 
            '<span>Text Color: <input type="color" id="' + textPickerId + '" class="inline-picker" value="#00ff66"></span>' +
            '<span>Background: <input type="color" id="' + bgPickerId + '" class="inline-picker" value="#0d0d0d"></span>';
          output.appendChild(pickerContainer); 
          
          setTimeout(() => {
            let tp = document.getElementById(textPickerId);
            let bp = document.getElementById(bgPickerId);
            if (tp) tp.addEventListener('input', (ev) => { container.style.color = ev.target.value; });
            if (bp) bp.addEventListener('input', (ev) => { container.style.backgroundColor = ev.target.value; });
          }, 50);
          resetInput();
          scrollToBottom();
          maintainFocus();
          return;
        } else if (cmdLower === 'theme') {
          let themeArgs = arg.split(' ').filter(a => a.trim() !== '');
          if (themeArgs.length === 0) {
            response = '<Console> Usage: theme [text_color] [bg_color]';
          } else {
            container.classList.remove('rainbow-mode', 'rainbow-bg');
            container.style.color = themeArgs[0];
            if (themeArgs[1]) container.style.backgroundColor = themeArgs[1];
            response = '<Console> Color scheme updated.';
          }
        } else if (cmdLower === 'time') {
          response = arg ? '<Console> Time (' + arg.toUpperCase() + '): ' + parseOffsetTime(arg) : '<Console> Local time: ' + new Date().toLocaleTimeString();
        
        // --- EASTER EGGS START HERE ---
        } else if (cmdLower === 'hi' || cmdLower === 'hello') {
          response = '<Console> Hello! Type "help" to see what I can do.';
        } else if (cmdLower === 'sudo') {
          response = '<Console> Nice try. But you don\'t have root access here.';
        } else if (cmdLower === 'hack') {
          if (!matrixInterval) toggleMatrix(); 
          response = '<Console> [SYSTEM BREACHED... JUST KIDDING.] 🟩 Type "matrix" to turn it off.';
        // --- EASTER EGGS END HERE ---

        } else {
          playError();
          response = '<Console> Command not recognized: "' + fullInput + '". Type "help" for options.';
        }

        writeLine(response);
        resetInput();
        scrollToBottom();
        maintainFocus();
      }
    });
  }).toString() + ")();";
  
  (0, eval)(window.__TERMINAL_SCRIPT__);
})();
