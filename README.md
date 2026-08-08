<div align="center">
  <h1>🤖 Nano Web Agent — Automação Web & Agente de IA para Navegadores</h1>
  <p><b>Agente Autônomo e Inteligente que navega, preenche formulários, inspeciona DOM e executa tarefas no seu browser via Google Gemini ou LLMs Locais (Ollama).</b></p>

  <p align="center">
    <img src="https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?style=for-the-badge&logo=google-chrome" alt="Chrome Extension"/>
    <img src="https://img.shields.io/badge/LLM-Google_Gemini-8E75B2?style=for-the-badge&logo=google" alt="Gemini"/>
    <img src="https://img.shields.io/badge/Local_AI-Ollama-000000?style=for-the-badge&logo=ollama" alt="Ollama"/>
    <img src="https://img.shields.io/badge/Licença-Proprietária%20%2F%20Comercial-red?style=for-the-badge&logo=shield" alt="Licença"/>
  </p>
</div>

---

> [!CAUTION]
> **TERMOS DE LICENCIAMENTO & RESTRICAO COMERCIAL**
> 
> O **Nano Web Agent** é um software de automação avançado desenvolvido por **Eduardo Junior Alcântara da Silva**.
> - 🎓 **Uso Pessoal & Acadêmico:** 100% Gratuito, exigindo a devida **atribuição de autoria** e link para este repositório.
> - 💼 **Uso Comercial & Lucrativo:** **Estritamente proibido** utilizar este código em soluções pagas, SaaS ou serviços comerciais sem autorização prévia por escrito e pagamento de comissões/royalties. Leia o arquivo [`LICENSE.md`](file:///LICENSE.md).

---

## 📌 Visão Geral

Inspirado em soluções pioneiras de *Computer Use* (como o Claude Computer Use da Anthropic), o **Nano Web Agent** é uma extensão potente que transforma modelos de linguagem em **agentes autônomos que operam a Web**. 

Ele permite que você delegue tarefas repetitivas, maçantes ou complexas diretamente no navegador:
- 📝 Preenchimento automático de formulários e cadastros com base em dados brutos.
- 🔍 Inspeção dinâmica da árvore de acessibilidade e estruturas de dados do DOM.
- ⚡ Execução de ações reais no navegador (cliques, inputs de texto, rolagem, seleção de opções).
- 🤖 Suporte a **LLMs Locais (Ollama)** para rodar 100% offline e sem custos de API, ou **Google Gemini API** para máxima capacidade analítica.

---

## 🏗️ Arquitetura do Sistema

O sistema é construído sobre a arquitetura de **Manifest V3** com comunicação assíncrona baseada em eventos entre a interface do usuário, o background script e os scripts de conteúdo injetados na página ativa.

```mermaid
graph TD
    User["👤 Usuário / Side Panel"] -->|Injeta Instrução| Popup["🎛️ Sidepanel UI / Settings"]
    Popup -->|Message Passing| BG["⚙️ Background Service Worker"]
    
    subgraph "Engine de Decisão (LLM Provider)"
        BG -->|Prompt + Contexto DOM| Gemini["🌐 Google Gemini API"]
        BG -->|Prompt + Contexto DOM| Ollama["🏠 Ollama (Llama3/Gemma Local)"]
    end
    
    Gemini -->|Resposta JSON (Tool Calls)| BG
    Ollama -->|Resposta JSON (Tool Calls)| BG
    
    BG -->|Injeta Ação| CS["📜 Content Script (DOM Manipulator)"]
    CS -->|Clique / Digitacao / Scroll| Page["🌐 Página Web Ativa"]
    Page -->|Novo Estado do DOM| CS
    CS -->|Árvore de Acessibilidade| BG
```

---

## 🌟 Principais Funcionalidades

### 1. 🔀 Suporte Híbrido Multi-LLM (Cloud + Local)
- **Nuvem (Google Gemini):** Utilize a chave da API do Gemini (Flash ou Pro) para resolução rápida e raciocínio multimodal complexo.
- **Local (Ollama):** Conecte a extensão ao seu endpoint local do Ollama (`http://localhost:11434`) para executar modelos como **Llama 3, Gemma ou Mistral** sem enviar dados para a nuvem.

### 2. 👁️ Análise Inteligente de DOM (Accessibility Tree)
Em vez de enviar screenshots pesadas a todo momento, a extensão extrai uma representação enxuta e semântica do DOM (árvore de acessibilidade), identificando IDs, botões interativos e campos de formulário, resultando em menor consumo de tokens e maior precisão.

### 3. 🕹️ Motor de Ações Autônomas
O agente é capaz de interpretar ordens em linguagem natural e traduzi-las em ações ordenadas:
- `click(selector)`: Clica em elementos visíveis.
- `type(selector, text)`: Preenche inputs e textareas.
- `scroll(direction)`: Rola a página para revelar novos elementos.
- `wait(ms)`: Aguarda carregamentos assíncronos (AJAX/Fetch).

---

## 📦 Como Instalar no Navegador (Developer Mode)

1. Clone ou baixe este repositório:
   ```bash
   git clone https://github.com/Eduardo00073/nano-web-agent.git
   ```
2. Abra o seu navegador baseado em Chromium (Google Chrome, Microsoft Edge, Brave).
3. Acesse a página de extensões: `chrome://extensions/`
4. Ative o **Modo do desenvolvedor** no canto superior direito.
5. Clique em **Carregar sem compactação** (Load unpacked) e selecione a pasta `src/` dentro do repositório.
6. A extensão será carregada e o ícone ficará disponível na sua barra de ferramentas!

---

## ⚙️ Configuração Inicial

1. Clique no ícone da extensão para abrir as **Configurações**.
2. Selecione o seu provedor de IA preferido:
   - **Google Gemini:** Insira sua API Key obtida no Google AI Studio.
   - **Ollama Local:** Certifique-se de que o Ollama está rodando e configure a URL base (`http://localhost:11434`).
3. Abra o **Side Panel** no navegador e comece a enviar comandos!

---

## 💼 Licenciamento e Contato Comercial

Para licenciar este software para uso corporativo, integração em produtos SaaS ou consultoria:

- **Desenvolvedor:** Eduardo Junior Alcântara da Silva
- 💼 **LinkedIn:** [linkedin.com/in/edu7](https://www.linkedin.com/in/edu7/)
- 🌐 **Website:** [www.prof-eduardo.com](https://www.prof-eduardo.com/)

---

<div align="center">
  <p>© 2026 Eduardo Junior Alcântara da Silva. Todos os direitos reservados.</p>
</div>
