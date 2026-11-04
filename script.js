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

    const CMD_HISTORY_KEY = 'retro_cmd_history';
    const CMD_HISTORY_MAX = 200;
    let persistentHistory = [];
    try {
      persistentHistory = JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]');
      if (!Array.isArray(persistentHistory)) persistentHistory = [];
    } catch (e) { persistentHistory = []; }

    function pushPersistentHistory(cmd) {
      if (!cmd) return;
      if (persistentHistory[persistentHistory.length - 1] === cmd) return;
      persistentHistory.push(cmd);
      if (persistentHistory.length > CMD_HISTORY_MAX) persistentHistory.shift();
      try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(persistentHistory)); } catch (e) {}
    }

    const WORKER_URL = 'https://console-ai-js.qwerty12345-1o1.workers.dev';
    
    const SCRIPT_ORIGIN = (function () {
      try {
        const cur = document.currentScript && document.currentScript.src;
        if (cur) return new URL(cur).origin;
      } catch (e) {}
      const s = document.querySelector('script[src*="script.js"]');
      if (s && s.src) return new URL(s.src).origin;
      return window.location.origin;
    })();

    const errorSound = new Audio(SCRIPT_ORIGIN + '/error.mp3');
    errorSound.volume = 0.5;
    errorSound.preload = 'auto';
    let audioUnlocked = false;

    const memeSounds = {
      'worcestershire': new Audio(SCRIPT_ORIGIN + '/Worcestershire sauce meme.mp3'),
      'building': new Audio(SCRIPT_ORIGIN + "/Don't be racist, I Am A Building.mp3")
    };
    
    Object.values(memeSounds).forEach(sound => {
      sound.preload = 'auto';
      sound.volume = 0.6;
    });

    function playError() {
      if (audioUnlocked) {
        errorSound.currentTime = 0; 
        errorSound.play().catch(e => {});
      }
    }

    function playMemeSound(type) {
      if (audioUnlocked && memeSounds[type]) {
        memeSounds[type].currentTime = 0;
        memeSounds[type].play().catch(e => {});
      }
    }

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
    let chatHistory = []; 
    let isChatMode = false;
    let commandBusy = false;
    let testRunning = false;
    let tttState = null;
    let customGameState = null;
    let privacyGateActive = false;

    let customCommands = {};
    try {
      customCommands = JSON.parse(localStorage.getItem('retro_custom_cmds') || '{}');
    } catch(e) {}

    const PROVIDER_COLORS = {
      'openai': '#4da6ff',
      'nvidia/nemotron-3.5-super-vl:free': '#ff6b6b',
      'recursive/flint-v1.0:free': '#a855f7',
      'ollama': '#ffd93d',
      'groq-120b': '#f97316',
      'groq-20b': '#ec4899',
      'groq-safety': '#eab308',
      'gemini': '#3b82f6',
      'cloudflare-ai': '#f59e0b'
    };

    let codeColors = {
      keyword: '#c678dd',
      string: '#98c379',
      number: '#d19a66',
      comment: '#5c6370',
      text: '#00ff66'
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
        escaped = escaped.replace(/\b(let|const|var|function|return|if|else|for|while|class|new|import|export|from|try|catch|await|async|typeof|instanceof)\b/g, `<span style="color: ${codeColors.keyword}; font-weight: bold;">$1</span>`);
        escaped = escaped.replace(/(['"`])(.*?)\1/g, `<span style="color: ${codeColors.string};">$1$2$1</span>`);
        escaped = escaped.replace(/\b(\d+(\.\d+)?)\b/g, `<span style="color: ${codeColors.number};">$1</span>`);
        escaped = escaped.replace(/(\/\/.*)/g, `<span style="color: ${codeColors.comment}; font-style: italic;">$1</span>`);
      } else if (lang === 'py') {
        escaped = escaped.replace(/\b(def|return|if|elif|else|for|while|import|from|as|try|except|finally|with|class|print|in|is|not|and|or|True|False|None)\b/g, `<span style="color: ${codeColors.keyword}; font-weight: bold;">$1</span>`);
        escaped = escaped.replace(/(['"])(.*?)\1/g, `<span style="color: ${codeColors.string};">$1$2$1</span>`);
        escaped = escaped.replace(/(#.*)/g, `<span style="color: ${codeColors.comment}; font-style: italic;">$1</span>`);
      }
      return escaped;
    }

    function formatAIResponse(provider, text) {
      let out = String(text).trim();
      if (provider === 'groq-safety') {
        out += '\n[DISCLAIMER: This response came from the Safety Model. It is designed to check inputs and may not answer complex prompts perfectly.]';
      }
      return '<Console> [' + provider + ']\n' + out;
    }

    // --- TIC TAC TOE (CLASSIC) FUNCTIONS ---
    function tttRenderBoard(board) {
      let out = '\n';
      for (let i = 0; i < 9; i++) {
        out += ' ' + (board[i] || (i + 1)) + ' ';
        if ((i + 1) % 3 === 0) {
          out += '\n';
          if (i < 6) out += '---+---+---\n';
        } else {
          out += '|';
        }
      }
      return out;
    }

    function tttCheckWin(board, player) {
      const wins = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
      ];
      return wins.some(combo => combo.every(idx => board[idx] === player));
    }

    function tttMinimax(newBoard, player) {
      const availSpots = newBoard.map((val, idx) => val === null ? idx : null).filter(val => val !== null);

      if (tttCheckWin(newBoard, 'X')) return { score: -10 };
      else if (tttCheckWin(newBoard, 'O')) return { score: 10 };
      else if (availSpots.length === 0) return { score: 0 };

      const moves = [];
      for (let i = 0; i < availSpots.length; i++) {
        const move = {};
        move.index = availSpots[i];
        newBoard[availSpots[i]] = player;

        if (player === 'O') {
          const result = tttMinimax(newBoard, 'X');
          move.score = result.score;
        } else {
          const result = tttMinimax(newBoard, 'O');
          move.score = result.score;
        }

        newBoard[availSpots[i]] = null;
        moves.push(move);
      }

      let bestMove;
      if (player === 'O') {
        let bestScore = -10000;
        for (let i = 0; i < moves.length; i++) {
          if (moves[i].score > bestScore) {
            bestScore = moves[i].score;
            bestMove = i;
          }
        }
      } else {
        let bestScore = 10000;
        for (let i = 0; i < moves.length; i++) {
          if (moves[i].score < bestScore) {
            bestScore = moves[i].score;
            bestMove = i;
          }
        }
      }
      return moves[bestMove];
    }

    function tttAIMove(board, difficulty) {
      const empty = board.map((val, idx) => val === null ? idx : null).filter(val => val !== null);
      if (empty.length === 0) return -1;

      if (difficulty === 'noob') {
        return empty[Math.floor(Math.random() * empty.length)];
      }

      if (difficulty === 'easy' || difficulty === 'medium') {
        for (let i = 0; i < 9; i++) {
          if (board[i] === null) {
            board[i] = 'O';
            if (tttCheckWin(board, 'O')) { board[i] = null; return i; }
            board[i] = null;
          }
        }
        for (let i = 0; i < 9; i++) {
          if (board[i] === null) {
            board[i] = 'X';
            if (tttCheckWin(board, 'X')) { board[i] = null; return i; }
            board[i] = null;
          }
        }
        if (difficulty === 'medium' && Math.random() < 0.5) {
          return tttMinimax(board, 'O').index;
        }
      }

      let mistakeChance = 0;
      if (difficulty === 'hard') mistakeChance = 0.15;
      if (difficulty === 'insane') mistakeChance = 0.05;
      if (difficulty === 'master') mistakeChance = 0.01;

      if (mistakeChance > 0 && Math.random() < mistakeChance) {
        return empty[Math.floor(Math.random() * empty.length)];
      }

      if (difficulty === 'hard' || difficulty === 'insane' || difficulty === 'master') {
        return tttMinimax(board, 'O').index;
      }

      return empty[Math.floor(Math.random() * empty.length)];
    }

    // --- CUSTOM GAME (ADJUSTABLE) FUNCTIONS ---
    function customRenderBoard(state) {
      let out = '\n';
      for (let r = 0; r < state.height; r++) {
        let rowStr = '';
        for (let c = 0; c < state.width; c++) {
          const idx = r * state.width + c;
          const val = state.board[idx];
          let cellContent = '';
          
          if (val === null) {
            cellContent = String(idx + 1).padStart(3, ' ');
          } else {
            cellContent = '  ' + val + '  ';
          }
          
          rowStr += cellContent;
          if (c < state.width - 1) rowStr += '|';
        }
        out += rowStr + '\n';
        
        if (r < state.height - 1) {
          let divStr = '';
          for (let c = 0; c < state.width; c++) {
             divStr += '---+';
          }
          out += divStr + '\n';
        }
      }
      return out;
    }

    function customCheckWin(board, width, height, winLen, player) {
      // Check horizontal
      for (let r = 0; r < height; r++) {
        for (let c = 0; c <= width - winLen; c++) {
          let count = 0;
          for (let i = 0; i < winLen; i++) {
            if (board[r * width + c + i] === player) count++;
            else break;
          }
          if (count === winLen) return true;
        }
      }
      // Check vertical
      for (let c = 0; c < width; c++) {
        for (let r = 0; r <= height - winLen; r++) {
          let count = 0;
          for (let i = 0; i < winLen; i++) {
            if (board[(r + i) * width + c] === player) count++;
            else break;
          }
          if (count === winLen) return true;
        }
      }
      // Check diagonal (top-left to bottom-right)
      for (let r = 0; r <= height - winLen; r++) {
        for (let c = 0; c <= width - winLen; c++) {
          let count = 0;
          for (let i = 0; i < winLen; i++) {
            if (board[(r + i) * width + c + i] === player) count++;
            else break;
          }
          if (count === winLen) return true;
        }
      }
      // Check diagonal (top-right to bottom-left)
      for (let r = 0; r <= height - winLen; r++) {
        for (let c = winLen - 1; c < width; c++) {
          let count = 0;
          for (let i = 0; i < winLen; i++) {
            if (board[(r + i) * width + c - i] === player) count++;
            else break;
          }
          if (count === winLen) return true;
        }
      }
      return false;
    }

    function customAI_Move(state) {
      const empty = state.board.map((val, idx) => val === null ? idx : null).filter(val => val !== null);
      if (empty.length === 0) return -1;

      // 1. Slip up chance
      if (Math.random() < state.slipChance) {
        const adjacent = empty.filter(idx => {
          const r = Math.floor(idx / state.width);
          const c = idx % state.width;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr, nc = c + dc;
              if (nr >= 0 && nr < state.height && nc >= 0 && nc < state.width) {
                if (state.board[nr * state.width + nc] !== null) return true;
              }
            }
          }
          return false;
        });
        if (adjacent.length > 0 && Math.random() < 0.8) {
           return adjacent[Math.floor(Math.random() * adjacent.length)];
        }
        return empty[Math.floor(Math.random() * empty.length)];
      }

      // 2. Try to win
      for (let i = 0; i < empty.length; i++) {
        state.board[empty[i]] = state.aiPlayer;
        if (customCheckWin(state.board, state.width, state.height, state.winLen, state.aiPlayer)) {
          state.board[empty[i]] = null;
          return empty[i];
        }
        state.board[empty[i]] = null;
      }

      // 3. Try to block player
      for (let i = 0; i < empty.length; i++) {
        state.board[empty[i]] = state.player;
        if (customCheckWin(state.board, state.width, state.height, state.winLen, state.player)) {
          state.board[empty[i]] = null;
          return empty[i];
        }
        state.board[empty[i]] = null;
      }

      // 4. Play near existing pieces
      const adjacent = empty.filter(idx => {
        const r = Math.floor(idx / state.width);
        const c = idx % state.width;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < state.height && nc >= 0 && nc < state.width) {
              if (state.board[nr * state.width + nc] !== null) return true;
            }
          }
        }
        return false;
      });
      
      if (adjacent.length > 0) {
        return adjacent[Math.floor(Math.random() * adjacent.length)];
      }
      return empty[Math.floor(Math.random() * empty.length)];
    }

    // ----------------------------------------

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
        if (!container.classList.contains('rainbow-mode')) {
          container.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
        }
        return '<Console> Matrix mode disabled.';
      } else {
        matrixCanvas.style.display = 'block';
        container.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
        
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
          ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
          ctx.fillRect(0, 0, matrixCanvas.width, matrixCanvas.height);
          
          const cbMode = container.dataset.cbMode;
          if (cbMode === 'deuteranopia' || cbMode === 'deuteranomaly') {
            ctx.fillStyle = "#ffff00";
          } else if (cbMode === 'protanopia' || cbMode === 'protanomaly') {
            ctx.fillStyle = "#00ffff";
          } else if (cbMode === 'tritanopia' || cbMode === 'tritanomaly') {
            ctx.fillStyle = "#ff00ff";
          } else {
            ctx.fillStyle = "#00ff66";
          }
          
          ctx.font = fontSize + "px monospace";

          for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(text, i * fontSize, drops[i] * fontSize);

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
          } finally {
            input.disabled = false;
            maintainFocus();
          }
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
      let str = String(offsetStr).toUpperCase().replace('UTC', '').replace('GMT', '').trim();
      if (!/^[+-]?\d{1,2}([:.]\d{2})?$/.test(str)) {
        return new Date().toLocaleTimeString('en-US', { timeZone: 'UTC' }) + ' (UTC — invalid offset ignored)';
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
      
      writeLine('\n--- [NETWORK & IP] ---');
      try {
        const ipRes = await fetch('https://ipapi.co/json/');
        if (ipRes.ok) {
          const ipData = await ipRes.json();
          writeLine(`Public IP: ${ipData.ip}`);
          writeLine(`Location: ${ipData.city}, ${ipData.region}, ${ipData.country_name}`);
          writeLine(`ISP / Org: ${ipData.org}`);
          writeLine(`Timezone: ${ipData.timezone}`);
        } else {
          writeLine('IP Fetch: Failed');
        }
      } catch (e) {
        writeLine('IP Fetch: Blocked or Offline');
      }

      writeLine('\n--- [GPU / RENDERER] ---');
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
            const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
            writeLine(`GPU Vendor: ${vendor}`);
            writeLine(`GPU Renderer: ${renderer}`);
          } else {
            writeLine('GPU Info: WebGL debug extension not supported.');
          }
        } else {
          writeLine('GPU Info: WebGL not supported.');
        }
      } catch (e) {
        writeLine('GPU Info: Blocked by browser');
      }

      writeLine('\n--- [HARDWARE (Estimated)] ---');
      writeLine(`CPU Cores (Logical): ${navigator.hardwareConcurrency || 'Unknown'}`);
      writeLine(`Device Memory (Est): ${navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'Unknown'}`);
      writeLine(`Max Touch Points: ${navigator.maxTouchPoints || 0}`);
      
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

      writeLine('\n--- [OS & BROWSER] ---');
      writeLine(`OS (Platform): ${navigator.platform}`);
      writeLine(`Browser: ${navigator.userAgent.includes('Brave') ? 'Brave' : 'Chromium/Other'}`);
      writeLine(`User Agent: ${navigator.userAgent}`);
      writeLine(`Language: ${navigator.language}`);
      writeLine(`Cookie Enabled: ${navigator.cookieEnabled}`);

      writeLine('\n--- [DISPLAY & SCREEN] ---');
      writeLine(`Screen Resolution: ${window.screen.width}x${window.screen.height}`);
      writeLine(`Available Screen: ${window.screen.availWidth}x${window.screen.availHeight}`);
      writeLine(`Window Size: ${window.innerWidth}x${window.innerHeight}`);
      writeLine(`Color Depth: ${window.screen.colorDepth}-bit`);
      writeLine(`Pixel Ratio: ${window.devicePixelRatio}`);
      writeLine(`Orientation: ${window.screen.orientation ? window.screen.orientation.type : 'Unknown'}`);

      writeLine('\n--- [CLOUD APIS] ---');
      try {
        const res = await fetch(WORKER_URL, { method: 'GET' });
        if (res.ok) {
          const data = await res.json();
          writeLine(`Worker State: ${data.online ? 'online' : 'unknown'} (HTTP ${res.status})`);
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

      writeLine('\n<Console> [Info Complete]');
      scrollToBottom();
    }

    async function fetchAIResponse(promptText, isSequential = false) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); 
        
        chatHistory.push({ role: 'user', content: promptText });

        const response = await fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ 
            prompt: promptText,
            history: chatHistory,
            isSequential: isSequential
          }) 
        });
        clearTimeout(timeoutId);
        const data = await response.json();
        
        if (response.ok && data.success) {
          if (data.responses && data.responses.length > 0) {
             chatHistory.push({ role: 'assistant', content: data.responses[0].text });
          }
          return { success: true, responses: data.responses, errors: data.errors };
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

    function requirePrivacyConsent(subject, onAgree) {
      if (privacyGateActive) return;
      privacyGateActive = true;

      writeLine('<Console> [WARNING - PRIVACY ADVISORY]');
      writeLine('The "' + subject + '" command will display sensitive system information (Public IP, location, OS, hardware, browser details).');
      writeLine('If you are streaming, recording, or screen-sharing, please PAUSE your stream or END it now.');
      writeLine('Type "agree" to continue, or "end" to cancel.');
      scrollToBottom();

      const handler = (evt) => {
        if (evt.key !== 'Enter') return;
        evt.preventDefault();
        evt.stopImmediatePropagation();

        const val = input.value.trim().toLowerCase();
        if (val === 'agree') {
          privacyGateActive = false;
          input.removeEventListener('keydown', handler, true);
          writeLine('<Console> [System]: Privacy agreement accepted. Starting ' + subject + '...');
          resetInput();
          onAgree();
        } else if (val === 'end') {
          privacyGateActive = false;
          input.removeEventListener('keydown', handler, true);
          writeLine('<Console> [System]: ' + subject + ' cancelled.');
          resetInput();
          maintainFocus();
        } else {
          writeLine('<Console> [System]: Please type "agree" to continue or "end" to cancel.');
          resetInput();
        }
      };
      input.addEventListener('keydown', handler, true);
      maintainFocus();
    }
    
    container.addEventListener('click', (e) => {
      if (window.getSelection().toString().length > 0) return; 
      if (!e.target.classList.contains('inline-picker') && !e.target.closest('.sandbox-editor') && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON' && !e.target.closest('.emulator-wrapper')) {
        maintainFocus();
      }
    });

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        let currentText = input.value.trim().toLowerCase();
        if (currentText === '') return;

        const allCommands = [
          'help', 'test', 'zones', 'weather', 'define', 'calc', 'password', 
          'top', 'matrix', 'save', 'copy', 'whereami', 'share', 'credits', 
          'clear', 'history', 'restore', 'info', 'mode', 'ollama', 'terminal', 
          'linux', 'exit', 'sandbox', 'file', 'note', 'notes', 'wipe', 
          'picker', 'theme', 'rainbow', 'colorblind', 'ascii', 'flip', 
          'roll', 'echo', 'lines', 'chat', 'js?', 'py?', 'meme', 'play', 'ttt'
        ];

        const match = allCommands.find(cmd => cmd.startsWith(currentText));
        if (match) {
          input.value = match + ' '; 
          autoResize();
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (persistentHistory.length === 0) return;
        if (historyIndex < persistentHistory.length - 1) {
          historyIndex++;
          input.value = persistentHistory[persistentHistory.length - 1 - historyIndex];
          autoResize();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex--;
          input.value = persistentHistory[persistentHistory.length - 1 - historyIndex];
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

        if (privacyGateActive) {
          resetInput();
          return;
        }

        historyIndex = -1;
        let nowFormatted = new Date().toLocaleTimeString();
        if (!sessionStartTime) sessionStartTime = nowFormatted;

        commandLog.push({ cmd: fullInput, time: nowFormatted });
        pushPersistentHistory(fullInput);
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

        let parts = fullInput.split(' ');
        let cmdLower = parts[0].toLowerCase();
        let arg = parts.slice(1).join(' ');

        if (cmdLower === 'chat') {
          if (isChatMode) {
            isChatMode = false;
            chatHistory = []; 
            writeLine('<Console> Exited Chat Mode. AI memory cleared.');
          } else {
            isChatMode = true;
            chatHistory = []; 
            writeLine('<Console> Entered Chat Mode. Just type your messages normally. Type "chat" again to exit.');
          }
          resetInput();
          scrollToBottom();
          maintainFocus();
          return;
        }

        if (isChatMode) {
          writeLine('<Console> [Thinking...]');
          resetInput();
          input.disabled = true;
          
          let cloudResult = await fetchAIResponse(fullInput, false);

          if (cloudResult.success && cloudResult.responses && cloudResult.responses.length > 0) {
            if (currentMode === 'single') {
              const res = cloudResult.responses[0];
              const line = writeLine(formatAIResponse(res.provider, res.text));
              line.style.color = PROVIDER_COLORS[res.provider] || 'inherit';
            } else {
              cloudResult.responses.forEach(res => {
                const line = writeLine(formatAIResponse(res.provider, res.text) + '\n---');
                line.style.color = PROVIDER_COLORS[res.provider] || 'inherit';
              });
            }
            
            if (cloudResult.errors && cloudResult.errors.length > 0) {
              cloudResult.errors.forEach(err => {
                const line = writeLine(`<Console> [Error] ${err.provider} failed: ${err.error}`);
                line.style.color = '#ff6b6b';
              });
            }
          } else if (ollamaEnabled) {
            writeLine('<Console> [Chat Error]: ' + (cloudResult.error || 'cloud failed') + ' — trying local Ollama...');
            const ollamaResult = await callOllama(fullInput);
            if (ollamaResult.success) {
              const line = writeLine('<Console> [ollama]\n' + ollamaResult.text.trim());
              line.style.color = PROVIDER_COLORS['ollama'];
            } else {
              writeLine('<Console> [Ollama Error]: ' + ollamaResult.error);
            }
          } else {
             writeLine('<Console> [Chat Error]: ' + cloudResult.error);
             writeLine('<Console> Tip: type "ollama on" to enable a local fallback.');
          }
          
          input.disabled = false;
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
              line.innerHTML = `<span style="color: ${codeColors.text};">&lt;Console&gt; [Result]:</span><br>` + highlightCode(String(evalResult), 'js');
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
            line.innerHTML = `<span style="color: ${codeColors.text};">&lt;Console&gt; [Result]:</span><br>` + highlightCode(pyOutput, 'py');
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

          let cloudResult = await fetchAIResponse(promptText, false);
          
          if (cloudResult.success && cloudResult.responses && cloudResult.responses.length > 0) {
            if (currentMode === 'single') {
              const res = cloudResult.responses[0];
              const line = writeLine(formatAIResponse(res.provider, res.text) + '\n---');
              line.style.color = PROVIDER_COLORS[res.provider] || 'inherit';
            } else {
              cloudResult.responses.forEach(res => {
                const line = writeLine(formatAIResponse(res.provider, res.text) + '\n---');
                line.style.color = PROVIDER_COLORS[res.provider] || 'inherit';
              });
            }
            
            if (cloudResult.errors && cloudResult.errors.length > 0) {
              cloudResult.errors.forEach(err => {
                const line = writeLine(`<Console> [Error] ${err.provider} failed: ${err.error}`);
                line.style.color = '#ff6b6b';
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
          if (testRunning) {
            writeLine('<Console> [Test already running]');
            resetInput();
            maintainFocus();
            return;
          }
          testRunning = true;
          resetInput();
          writeLine('<Console> [STARTING MEGA-TEST SEQUENCE...]');

          const simulateType = async (text) => {
            if (privacyGateActive) {
              input.value = 'agree';
              autoResize();
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await new Promise(r => setTimeout(r, 300));
            }

            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 50));
            const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
            input.dispatchEvent(event);
            await new Promise((resolve) => {
              const start = Date.now();
              const tick = () => {
                if (!commandBusy || Date.now() - start > 30000) return resolve();
                setTimeout(tick, 100);
              };
              setTimeout(tick, 100);
            });
            await new Promise(r => setTimeout(r, 400));
          };

          const tour = [
            "help", "zones", "weather London", "define cat", "calc x3+y3+z3=k",
            "password", "top", "matrix", "matrix", "copy test", "whereami", "credits",
            "clear", "history", "restore 1", "info", "mode single", "mode multi",
            "ollama on", "ollama off", "note test", "notes", "picker",
            "theme #ff0000 #000000", "theme #00ff66 #0d0d0d", "rainbow", "rainbow",
            "colorblind deuteranopia", "colorblind off", "ascii", "flip", "roll", "roll 80",
            "echo test", "lines",
            "js? const arr = [1,2,3,4,5]; const nested = arr.map(x => ({ v: x, sq: x * x })); const fn = (a, b) => a.reduce((acc, c) => acc + c, b); fn(nested.map(o => o.sq), 0); null",
            "py? import math; data = [{'v': x, 'sq': x * x} for x in range(1, 6)]; total = sum(d['sq'] for d in data); print(math.factorial(10), total); None",
            "js? 9223372036854775807 + 1",
            "py? 9223372036854775807 + 1",
            "js? 2n**128n - 1n",
            "py? 2**128 - 1",
            "time", "utc-12", "utc-11", "utc-10", "utc-09:30", "utc-09", "utc-08", "utc-07",
            "utc-06", "utc-05", "utc-04", "utc-03:30", "utc-03", "utc-02", "utc-01",
            "utc+00:00", "utc+01", "utc+02", "utc+03", "utc+03:30", "utc+04", "utc+04:30",
            "utc+05", "utc+05:30", "utc+05:45", "utc+06", "utc+06:30", "utc+07", "utc+08",
            "utc+08:45", "utc+09", "utc+09:30", "utc+10", "utc+10:30", "utc+11", "utc+12",
            "utc+12:45", "utc+13", "utc+13:45", "utc+14", "lines"
          ];

          for (let i = 0; i < tour.length; i++) {
            writeLine(`<Console> [Test Step ${i + 1}/${tour.length}]: Executing "${tour[i]}"`);
            await simulateType(tour[i]);
          }

          writeLine("<Console> [MEGA-TEST COMPLETE]");
          testRunning = false;
          maintainFocus();
          return;
        } else if (cmdLower === 'help') {
          response = '<Console> Available commands:\n' +
                     ' - help (shows this menu)\n' +
                     ' - test (runs the automated mega-test tour)\n' +
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
                     ' - chat (starts a persistent conversation with AI memory)\n' +
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
                     ' - colorblind [mode] (accessibility color palettes)\n' +
                     ' - ascii (prints random ASCII art)\n' +
                     ' - flip (flips a coin)\n' +
                     ' - roll [sides] (rolls a die, defaults to 6 sides)\n' +
                     ' - echo [text] (prints text back)\n' +
                     ' - lines (shows total lines of console code)\n' +
                     ' - meme (plays a random meme sound)\n' +
                     ' - play [sound] (plays a specific meme sound)\n' +
                     ' - ttt [difficulty] (starts a game of Tic-Tac-Toe. Difficulties: noob, easy, medium, hard, insane, master)\n' +
                     ' - ttt ag [width] [height] [win] [slip%] [x|o] (Adjustable game. e.g., "ttt ag 5 9 4 5 x")\n' +
                     ' - *[prompt]* (chat with AI by wrapping prompt in asterisks)\n' +
                     ' - JS? [code] (run live JavaScript directly in browser)\n' +
                     ' - PY? [code] (run live Python via Pyodide)\n' +
                     ' - time (shows local time; "time UTC+5" or just "UTC+5" / "-5" for an offset)\n' +
                     ' - [offset] (shorthand for "time <offset>", e.g. "UTC+02:00" or "-5")\n\n' +
                     'Note: Get ollama because its a local fallback if all of my api keys fail, i got all of them for free so its likely :/';
        } else if (cmdLower === 'ttt') {
          if (arg.toLowerCase().startsWith('ag')) {
            // ADJUSTABLE GAME MODE
            const args = arg.split(' ').slice(1);
            if (args.length === 0) {
              response = '<Console> [Custom Game] Usage: ttt ag [width] [height] [win] [slip%] [x|o]\nExample: ttt ag 5 9 4 5 x';
            } else if (args.length < 5) {
              response = '<Console> [Custom Game] Invalid arguments. Need 5: width, height, win length, slip %, and player (x/o).\nExample: ttt ag 5 9 4 5 x';
            } else {
              const w = parseInt(args[0]);
              const h = parseInt(args[1]);
              const win = parseInt(args[2]);
              const slip = parseFloat(args[3]) / 100;
              const p = args[4].toLowerCase();

              if (isNaN(w) || isNaN(h) || isNaN(win) || isNaN(slip) || (p !== 'x' && p !== 'o')) {
                response = '<Console> [Custom Game] Invalid values. Make sure width/height/win are numbers, slip is a number, and player is x or o.';
              } else if (w < 2 || h < 2 || win < 2) {
                response = '<Console> [Custom Game] Board size and win length must be at least 2.';
              } else if (win > w && win > h) {
                response = '<Console> [Custom Game] Win length cannot be larger than both width and height.';
              } else {
                customGameState = {
                  width: w,
                  height: h,
                  winLen: win,
                  slipChance: slip,
                  player: p.toUpperCase(),
                  aiPlayer: p === 'x' ? 'O' : 'X',
                  board: Array(w * h).fill(null)
                };
                
                let initMsg = `<Console> [Custom Game] Started! Board: ${w}x${h}, Win length: ${win}, AI Slip Chance: ${args[3]}%. You are ${customGameState.player}.\n` + customRenderBoard(customGameState);
                
                if (customGameState.player === 'O') {
                  const aiMove = customAI_Move(customGameState);
                  customGameState.board[aiMove] = customGameState.aiPlayer;
                  initMsg += `\n<Console> The AI went first in the center.\n` + customRenderBoard(customGameState);
                }
                
                initMsg += `\nTo play, type "ttt [number]" (e.g. ttt 1).`;
                response = initMsg;
              }
            }
          } else if (customGameState) {
            // PLAYING CUSTOM GAME
            let move = parseInt(arg);
            if (move >= 1 && move <= customGameState.width * customGameState.height && customGameState.board[move - 1] === null) {
              customGameState.board[move - 1] = customGameState.player;
              
              if (customCheckWin(customGameState.board, customGameState.width, customGameState.height, customGameState.winLen, customGameState.player)) {
                response = '<Console> [Custom Game] You win!\n' + customRenderBoard(customGameState);
                customGameState = null;
              } else if (!customGameState.board.includes(null)) {
                response = '<Console> [Custom Game] It\'s a draw!\n' + customRenderBoard(customGameState);
                customGameState = null;
              } else {
                const aiMove = customAI_Move(customGameState);
                customGameState.board[aiMove] = customGameState.aiPlayer;
                
                if (customCheckWin(customGameState.board, customGameState.width, customGameState.height, customGameState.winLen, customGameState.aiPlayer)) {
                  response = '<Console> [Custom Game] The AI wins!\n' + customRenderBoard(customGameState);
                  customGameState = null;
                } else if (!customGameState.board.includes(null)) {
                  response = '<Console> [Custom Game] It\'s a draw!\n' + customRenderBoard(customGameState);
                  customGameState = null;
                } else {
                  response = '<Console> [Custom Game] Your turn (' + customGameState.player + ').\n' + customRenderBoard(customGameState);
                }
              }
            } else {
              response = '<Console> [Custom Game] Invalid move. Pick an empty spot.\n' + customRenderBoard(customGameState);
            }
          } else if (tttState) {
            // PLAYING CLASSIC GAME
            let move = parseInt(arg);
            if (move >= 1 && move <= 9 && tttState.board[move - 1] === null) {
              tttState.board[move - 1] = 'X';
              
              if (tttCheckWin(tttState.board, 'X')) {
                response = '<Console> [Tic-Tac-Toe] You win!\n' + tttRenderBoard(tttState.board);
                tttState = null;
              } else if (!tttState.board.includes(null)) {
                response = '<Console> [Tic-Tac-Toe] It\'s a draw!\n' + tttRenderBoard(tttState.board);
                tttState = null;
              } else {
                const aiMove = tttAIMove(tttState.board, tttState.difficulty);
                tttState.board[aiMove] = 'O';
                
                if (tttCheckWin(tttState.board, 'O')) {
                  response = '<Console> [Tic-Tac-Toe] The AI wins!\n' + tttRenderBoard(tttState.board);
                  tttState = null;
                } else if (!tttState.board.includes(null)) {
                  response = '<Console> [Tic-Tac-Toe] It\'s a draw!\n' + tttRenderBoard(tttState.board);
                  tttState = null;
                } else {
                  response = '<Console> [Tic-Tac-Toe] Your turn (X). Type "ttt [1-9]"\n' + tttRenderBoard(tttState.board);
                }
              }
            } else {
              response = '<Console> [Tic-Tac-Toe] Invalid move. Pick an empty spot (1-9).\n' + tttRenderBoard(tttState.board);
            }
          } else {
            // STARTING CLASSIC GAME
            const diff = arg.toLowerCase();
            if (['noob', 'easy', 'medium', 'hard', 'insane', 'master'].includes(diff)) {
              tttState = { board: Array(9).fill(null), difficulty: diff };
              customGameState = null; // Ensure custom is cleared
              response = `<Console> [Tic-Tac-Toe] Game started on ${diff.toUpperCase()} mode. You are X.\n` + tttRenderBoard(tttState.board) + '\nType "ttt [1-9]" to make a move.';
            } else if (diff === '') {
              response = '<Console> [Tic-Tac-Toe] Pick a difficulty: "ttt noob", "ttt easy", "ttt medium", "ttt hard", "ttt insane", or "ttt master".\nOr start an adjustable game: "ttt ag [width] [height] [win] [slip%] [x|o]"';
            } else {
              response = '<Console> [Tic-Tac-Toe] Invalid difficulty. Type "ttt" for options.';
            }
          }
        } else if (cmdLower === 'meme') {
          const keys = Object.keys(memeSounds);
          const randomMeme = keys[Math.floor(Math.random() * keys.length)];
          playMemeSound(randomMeme);
          response = `<Console> 🎵 Playing meme sound: [${randomMeme.toUpperCase()}]`;
        } else if (cmdLower === 'play') {
          if (memeSounds[arg]) {
            playMemeSound(arg);
            response = `<Console> 🎵 Playing: ${arg}`;
          } else {
            response = `<Console> Sound not found. Available: ${Object.keys(memeSounds).join(', ')}`;
          }
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
            requirePrivacyConsent('whereami', () => {
              input.value = 'whereami';
              autoResize();
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            });
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
            response = '<Console> Ollama fallback ENABLED.';
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
          try {
            requirePrivacyConsent('info', async () => {
              await runInfo();
              input.disabled = false;
              maintainFocus();
            });
          } catch (e) {
            input.disabled = false;
            maintainFocus();
          }
          return;
        } else if (cmdLower === 'linux') {
          resetInput();
          input.disabled = true;
          try {
            await runLinux();
          } finally {
            input.disabled = false;
            maintainFocus();
          }
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
          const isColorblind = ['protanopia', 'protanomaly', 'deuteranopia', 'deuteranomaly', 'tritanopia', 'tritanomaly'].includes(container.dataset.cbMode);

          if (isColorblind) {
            playError();
            response = '<Console> [Accessibility]: Rainbow mode is not compatible with colorblind mode. Please type "colorblind off" first.';
          } else if (container.classList.contains('rainbow-mode')) {
            container.classList.remove('rainbow-mode', 'rainbow-bg');
            container.style.color = codeColors.text;
            container.style.backgroundColor = matrixInterval ? 'rgba(0, 0, 0, 0.1)' : 'rgba(0, 0, 0, 0.4)';
            response = '<Console> Rainbow mode disabled.';
          } else {
            container.classList.add('rainbow-mode', 'rainbow-bg');
            response = '<Console> 🌈 RAINBOW MODE ENGAGED 🌈 (Type "rainbow" again to disable)';
          }
        } else if (cmdLower === 'colorblind') {
          if (!arg) {
            response = '<Console> Colorblind Modes available:\n' +
                       ' - colorblind protanopia\n' +
                       ' - colorblind protanomaly\n' +
                       ' - colorblind deuteranopia\n' +
                       ' - colorblind deuteranomaly\n' +
                       ' - colorblind tritanopia\n' +
                       ' - colorblind tritanomaly\n' +
                       ' - colorblind off';
          } else {
            container.classList.remove('rainbow-mode', 'rainbow-bg');
            container.dataset.cbMode = arg;
            
            if (arg === 'protanopia') {
              container.style.color = '#00ffff'; 
              container.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'; 
              codeColors = { keyword: '#00ffff', string: '#ffffff', number: '#aaaaaa', comment: '#666666', text: '#00ffff' };
              response = '<Console> Colorblind mode set to: PROTANOPIA';
            } else if (arg === 'protanomaly') {
              container.style.color = '#87ceeb'; 
              container.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'; 
              codeColors = { keyword: '#87ceeb', string: '#ffffff', number: '#aaaaaa', comment: '#666666', text: '#87ceeb' };
              response = '<Console> Colorblind mode set to: PROTANOMALY';
            } else if (arg === 'deuteranopia') {
              container.style.color = '#ffff00'; 
              container.style.backgroundColor = 'rgba(0, 0, 40, 0.9)'; 
              codeColors = { keyword: '#ffff00', string: '#ffffff', number: '#aaaaaa', comment: '#666666', text: '#ffff00' };
              response = '<Console> Colorblind mode set to: DEUTERANOPIA';
            } else if (arg === 'deuteranomaly') {
              container.style.color = '#ffd700'; 
              container.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
              codeColors = { keyword: '#ffd700', string: '#ffffff', number: '#aaaaaa', comment: '#666666', text: '#ffd700' };
              response = '<Console> Colorblind mode set to: DEUTERANOMALY';
            } else if (arg === 'tritanopia') {
              container.style.color = '#ff00ff'; 
              container.style.backgroundColor = 'rgba(0, 40, 40, 0.9)'; 
              codeColors = { keyword: '#ff00ff', string: '#ffffff', number: '#aaaaaa', comment: '#666666', text: '#ff00ff' };
              response = '<Console> Colorblind mode set to: TRITANOPIA';
            } else if (arg === 'tritanomaly') {
              container.style.color = '#ffb6c1'; 
              container.style.backgroundColor = 'rgba(0, 20, 20, 0.9)'; 
              codeColors = { keyword: '#ffb6c1', string: '#ffffff', number: '#aaaaaa', comment: '#666666', text: '#ffb6c1' };
              response = '<Console> Colorblind mode set to: TRITANOMALY';
            } else if (arg === 'off') {
              container.style.color = '#00ff66';
              container.style.backgroundColor = matrixInterval ? 'rgba(0, 0, 0, 0.1)' : 'rgba(0, 0, 0, 0.4)';
              codeColors = { keyword: '#c678dd', string: '#98c379', number: '#d19a66', comment: '#5c6370', text: '#00ff66' };
              container.dataset.cbMode = 'none';
              response = '<Console> Colorblind mode disabled. Restored default.';
            } else {
              playError();
              response = '<Console> Unknown mode. Type "colorblind" for options.';
            }
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
            let textContent = output.textContent;
            if (textContent.includes('Archived Sessions:')) {
                const parts = textContent.split('Archived Sessions:');
                const before = parts[0];
                const after = parts[1] ? parts[1].split('to reload a past console session.').slice(1).join('') : '';
                textContent = before + after;
            }

            archivedSessions.push({
              id: archivedSessions.length + 1,
              start: sessionStartTime,
              end: nowFormatted,
              content: textContent, 
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
        
        } else if (fullInput === 'CREATORISQWERTY I AM THE CREATOR') {
          response = '<Console> [Creator] Clearance verified. Welcome back, QWERTY.';
        } else {
          const looksLikeQuestion =
            /\?$/.test(fullInput) ||
            /^(how|what|where|when|why|who|which|can|could|should|would|is|are|do|does|did|tell me|explain|show me)\b/i.test(fullInput) ||
            /^(help me|i need|i want)\b/i.test(fullInput);

          if (!looksLikeQuestion) {
            playError();
            writeLine('<Console> Command not recognized: "' + fullInput + '". Type "help" for options.');
            resetInput();
            scrollToBottom();
            maintainFocus();
            return;
          }

          try {
            const res = await fetch(WORKER_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt: fullInput, history: [] })
            });
            const data = await res.json();
            
            if (data.success && data.responses && data.responses.length > 0) {
              writeLine(data.responses[0].text);
            } else {
              playError();
              writeLine('<Console> Command not recognized: "' + fullInput + '". Type "help" for options.');
            }
          } catch (err) {
            playError();
            writeLine('<Console> Command not recognized: "' + fullInput + '". Type "help" for options.');
          }
          
          resetInput();
          scrollToBottom();
          maintainFocus();
          return;
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
