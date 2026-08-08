/**
 * Gemini Browser Agent - Accessibility Tree Builder
 *
 * Injected em todas as páginas (document_start, all_frames).
 * Expõe window.__geminiElementMap e window.__generateAccessibilityTree
 * para uso pelo background via chrome.scripting.executeScript.
 *
 * O mapa de elementos usa WeakRef para não vazar memória.
 * Cada elemento interativo recebe um ref_id estável (ex: "ref_42").
 */
(function () {
  if (window.__geminiElementMap) return; // já injetado

  window.__geminiElementMap = {};
  window.__geminiRefCounter = 0;

  /**
   * Retorna o papel ARIA/semântico de um elemento.
   */
  function getRole(el) {
    const explicitRole = el.getAttribute('role');
    if (explicitRole) return explicitRole;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const roleMap = {
      a: 'link',
      button: 'button',
      input:
        type === 'submit' || type === 'button'
          ? 'button'
          : type === 'checkbox'
          ? 'checkbox'
          : type === 'radio'
          ? 'radio'
          : type === 'file'
          ? 'button'
          : type === 'range'
          ? 'slider'
          : 'textbox',
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      img: 'image',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      section: 'region',
      article: 'article',
      aside: 'complementary',
      form: 'form',
      table: 'table',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      label: 'label',
      dialog: 'dialog',
      details: 'group',
      summary: 'button',
    };

    return roleMap[tag] || 'generic';
  }

  /**
   * Extrai um nome/label legível do elemento.
   */
  function getLabel(el) {
    const tag = el.tagName.toLowerCase();

    // <select>: opção selecionada
    if (tag === 'select') {
      const opt =
        el.querySelector('option[selected]') ||
        el.options[el.selectedIndex];
      if (opt && opt.textContent) return opt.textContent.trim();
    }

    // Atributos ARIA/HTML
    for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
      const val = el.getAttribute(attr);
      if (val && val.trim()) return val.trim();
    }

    // label[for="id"]
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl && lbl.textContent && lbl.textContent.trim())
        return lbl.textContent.trim();
    }

    // Input com value (submit, ou preenchido)
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' && el.value) return el.value.trim();
      if (el.value && el.value.length < 80) return el.value.trim();
    }

    // Texto direto de botões e links
    if (['button', 'a', 'summary'].includes(tag)) {
      let txt = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) txt += child.textContent;
      }
      if (txt.trim()) return txt.trim();
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const t = el.textContent;
      if (t && t.trim()) return t.trim().substring(0, 120);
    }

    // Imagem sem texto — não há label
    if (tag === 'img') return '';

    // Texto de conteúdo genérico (mínimo 3 chars)
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    text = text.trim();
    if (text.length >= 3) {
      return text.length > 120 ? text.substring(0, 120) + '...' : text;
    }

    return '';
  }

  /**
   * Verifica se o elemento é visível na viewport e no DOM.
   */
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity) === 0 ||
      el.offsetWidth === 0 ||
      el.offsetHeight === 0
    )
      return false;
    return true;
  }

  /**
   * Verifica se o elemento é interativo.
   */
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (
      ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag)
    )
      return true;
    if (el.getAttribute('onclick') !== null) return true;
    if (el.getAttribute('tabindex') !== null) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    const role = el.getAttribute('role');
    if (['button', 'link', 'menuitem', 'option', 'checkbox', 'radio', 'tab', 'combobox'].includes(role))
      return true;
    return false;
  }

  /**
   * Verifica se o elemento é estrutural/semântico.
   */
  function isStructural(el) {
    const tag = el.tagName.toLowerCase();
    return (
      ['h1','h2','h3','h4','h5','h6','nav','main','header','footer','section','article','aside','dialog','form'].includes(tag) ||
      el.getAttribute('role') !== null
    );
  }

  /**
   * Decide se o elemento deve ser incluído na árvore.
   */
  function shouldInclude(el, options) {
    const tag = el.tagName.toLowerCase();

    // Sempre ignorar meta-tags
    if (['script','style','meta','link','title','noscript','template'].includes(tag))
      return false;

    // Respeitar aria-hidden (a menos que filter=all)
    if (options.filter !== 'all' && el.getAttribute('aria-hidden') === 'true')
      return false;

    // Verificar visibilidade
    if (options.filter !== 'all' && !isVisible(el)) return false;

    // Verificar se está dentro da viewport
    if (options.filter !== 'all' && !options.refId) {
      const rect = el.getBoundingClientRect();
      const inViewport =
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0;
      if (!inViewport) return false;
    }

    if (options.filter === 'interactive') return isInteractive(el);
    if (isInteractive(el)) return true;
    if (isStructural(el)) return true;
    if (getLabel(el).length > 0) return true;

    const role = getRole(el);
    return role !== null && role !== 'generic' && role !== 'image';
  }

  /**
   * Obtém ou cria um ref_id estável para o elemento.
   */
  function getOrCreateRef(el) {
    for (const id in window.__geminiElementMap) {
      const ref = window.__geminiElementMap[id];
      if (ref.deref() === el) return id;
    }
    const id = 'ref_' + (++window.__geminiRefCounter);
    window.__geminiElementMap[id] = new WeakRef(el);
    return id;
  }

  /**
   * Função principal — gera a árvore de acessibilidade como texto.
   *
   * @param {string} filter   - 'all' | 'interactive'
   * @param {number} maxDepth - profundidade máxima (padrão: 15)
   * @param {number} maxChars - limite de caracteres (padrão: 50000)
   * @param {string} refId    - focar em elemento específico
   * @returns {{ pageContent: string, viewport: object, error?: string }}
   */
  window.__generateAccessibilityTree = function (
    filter,
    maxDepth,
    maxChars,
    refId
  ) {
    try {
      const lines = [];
      const depth = maxDepth != null ? maxDepth : 15;
      const options = { filter: filter || 'all', refId: refId };

      function walk(el, level) {
        if (level > depth) return;
        if (!el || !el.tagName) return;

        const include = shouldInclude(el, options) || (refId != null && level === 0);

        if (include) {
          const role = getRole(el);
          const label = getLabel(el);
          const refIdVal = getOrCreateRef(el);

          let line = ' '.repeat(level) + role;
          if (label) {
            const cleanLabel = label.replace(/\s+/g, ' ').substring(0, 120).replace(/"/g, '\\"');
            line += ` "${cleanLabel}"`;
          }
          line += ` [${refIdVal}]`;

          // Atributos extras relevantes
          const href = el.getAttribute('href');
          if (href) line += ` href="${href}"`;

          const type = el.getAttribute('type');
          if (type) line += ` type="${type}"`;

          const placeholder = el.getAttribute('placeholder');
          if (placeholder) line += ` placeholder="${placeholder}"`;

          const checked = el.getAttribute('aria-checked') || (el.checked ? 'true' : null);
          if (checked) line += ` checked="${checked}"`;

          const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
          if (disabled) line += ' disabled';

          lines.push(line);

          // Para <select>, listar opções
          if (el.tagName.toLowerCase() === 'select') {
            for (const opt of el.options) {
              let optLine = ' '.repeat(level + 1) + 'option';
              if (opt.textContent) {
                optLine += ` "${opt.textContent.trim().substring(0, 100)}"`;
              }
              if (opt.selected) optLine += ' (selected)';
              lines.push(optLine);
            }
          }
        }

        // Recursão nos filhos
        if (el.children && level < depth) {
          for (const child of el.children) {
            walk(child, include ? level + 1 : level);
          }
        }

        // Shadow DOM — traversal recursivo em Web Components (Gmail, YouTube, etc.)
        if (el.shadowRoot && level < depth) {
          for (const child of el.shadowRoot.children) {
            walk(child, include ? level + 1 : level);
          }
        }

        // Iframes same-origin — incluir conteúdo do iframe na árvore
        if (el.tagName && el.tagName.toLowerCase() === 'iframe' && level < depth) {
          try {
            const iframeDoc = el.contentDocument;
            if (iframeDoc && iframeDoc.body) {
              lines.push(' '.repeat((include ? level + 1 : level)) + '(iframe: ' + (el.getAttribute('title') || el.getAttribute('name') || el.src || 'sem-título') + ')');
              for (const child of iframeDoc.body.children) {
                walk(child, (include ? level + 2 : level + 1));
              }
            }
          } catch (_) {
            // iframe cross-origin — ignorar silenciosamente
          }
        }
      }

      // Ponto de entrada
      if (refId) {
        const weakRef = window.__geminiElementMap[refId];
        if (!weakRef) {
          return {
            error: `Elemento com ref_id '${refId}' não encontrado. Use read_page sem ref_id para obter o estado atual.`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        const target = weakRef.deref();
        if (!target) {
          return {
            error: `Elemento com ref_id '${refId}' não existe mais no DOM.`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
        }
        walk(target, 0);
      } else {
        if (document.body) walk(document.body, 0);
      }

      // Limpar refs mortas
      for (const id in window.__geminiElementMap) {
        if (!window.__geminiElementMap[id].deref()) {
          delete window.__geminiElementMap[id];
        }
      }

      const content = lines.join('\n');

      if (maxChars != null && content.length > maxChars) {
        return {
          error: `Saída excede o limite de ${maxChars} caracteres (${content.length} chars). Use depth menor ou ref_id para focar em um elemento.`,
          pageContent: '',
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }

      return {
        pageContent: content,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    } catch (err) {
      throw new Error('Erro ao gerar accessibility tree: ' + (err.message || 'Erro desconhecido'));
    }
  };
})();
