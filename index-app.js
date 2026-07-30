/**
 * ÍNDICE DA ESTRUTURA — App.tsx (ShielD)
 * ---------------------------------------------------------
 * Gerado a partir do arquivo enviado (App.tsx, ~1249 linhas).
 * Este arquivo não é executável: é um mapa/sumário comentado
 * dos blocos que você mandou construir, na ordem em que aparecem.
 */

// ===========================================================
// 1. DADOS E CONSTANTES GLOBAIS
// ===========================================================
// - CATEGORIAS: lista de tipos de serviço de segurança
//   ['Lojas', 'Mercados', 'Eventos', 'Galpão', 'Apoio', 'Bar/Restaurante', 'Portaria']
// - LOGO_SRC_PRESTADOR: logo (base64 PNG) usado no lado do prestador
// - LOGO_SRC_CLIENTE:   logo (base64 PNG) usado no lado do cliente
// - DASHBOARD_HTML:     string HTML gigante (dashboard "standalone")
//   embutida no próprio arquivo (ver seção 8)

// ===========================================================
// 2. COMPONENTES DE UI / VISUAL BASE
// ===========================================================
function CleanBackground({ tone = 'teal' })                 {} // linha 15   — fundo estilizado (teal/dourado) usado nas telas de login/cadastro
function ChromeShield({ tone = 'teal', size = 'lg', pulse })  {} // linha 494  — ícone/escudo "cromado" com efeito de pulso
function AngledButton({ children, tone, variant, onClick,
                        type, disabled, icon: Icon })         {} // linha 532  — botão com borda angulada, usado nos CTAs
function StepDots({ step, total, tone })                      {} // linha 559  — indicador de progresso (bolinhas) dos steps de cadastro

// ===========================================================
// 3. CAMPOS DE FORMULÁRIO REUTILIZÁVEIS
// ===========================================================
function Field({ label, error, ...props })                   {} // linha 577  — input genérico com label + erro
function PasswordField({ label, value, onChange })            {} // linha 588  — campo de senha com toggle mostrar/ocultar + força da senha
function FileUploadField({ label, hint, file, onChange,
                           accept, icon: Icon, error })        {} // linha 623  — upload de arquivo (usado p/ antecedentes, foto do RG)

// ===========================================================
// 4. MODAIS GENÉRICOS
// ===========================================================
function Modal({ tone, title, subtitle, onClose, children })  {} // linha 658  — shell genérico de modal
function SuccessBlock({ tone, title, message, onDone })        {} // linha 679  — tela de "sucesso" pós-cadastro/login

// ===========================================================
// 5. TERMOS DE USO
// ===========================================================
function TermosConteudo()                                     {} // linha 693  — texto completo dos termos de uso
function TermosStep({ tone, accepted, setAccepted, onSubmit,
                      submitting, submitLabel, error })        {} // linha 765  — etapa final de aceite dos termos (usada nos 2 cadastros)

// ===========================================================
// 6. CADASTRO (multi-step) — CLIENTE E PRESTADOR
// ===========================================================
function CadastroClienteModal({ onClose, onSuccess })         {} // linha 800
//   Estados: step, form{nome,email,telefone,cpf,senha}, errors, saving, termsAccepted
//   Fluxo: validateStep() -> next() -> ... -> submit()

function CadastroPrestadorModal({ onClose, onSuccess })        {} // linha 894
//   Estados: step, form{nome,email,telefone,cpfCnpj,senha,bio},
//            categorias[], antecedentes(file), fotoRg(file),
//            errors, saving, termsAccepted
//   Extra: toggleCategoria(cat) — seleção múltipla de categorias de serviço
//   Fluxo: validateStep() -> next() -> ... -> submit()

// ===========================================================
// 7. LOGIN
// ===========================================================
function LoginModal({ tone, role, onClose, onLoginSuccess })  {} // linha 1033
//   Estados: form{email,senha}, errors, loading
//   submit(e) -> valida e chama onLoginSuccess()

// ===========================================================
// 8. DASHBOARDS (telas pós-login)
// ===========================================================
function ProviderDashboard({ onBack })                         {} // linha 1070
//   Renderiza o HTML standalone do prestador (ver DASHBOARD_HTML
//   / dashboard-prestador.html), com: painel de perfil, carteira,
//   toggle online/offline, demandas em tempo real, agenda,
//   trilha de níveis (Bronze→Prata→Ouro→Platina), chat com cliente

function ClientDashboard({ onBack })                           {} // linha 1093
//   Painel do cliente: publicar demanda, acompanhar prestador no mapa,
//   avaliações, histórico

// ===========================================================
// 9. APP RAIZ (default export)
// ===========================================================
export default function App() {}                              // linha 1115
// Estados principais:
//   role   -> 'cliente' | 'prestador'
//   modal  -> qual modal está aberto (cadastro/login/termos)
//   screen -> 'home' | 'providerDashboard' | 'clientDashboard'
//   toast  -> mensagem de feedback temporária (showToast)
//
// Roteamento simples por `screen`:
//   screen === 'providerDashboard' -> <ProviderDashboard />
//   screen === 'clientDashboard'   -> <ClientDashboard />
//   (padrão) -> tela inicial (home) com CTAs de login/cadastro
//               para cliente e prestador

// ===========================================================
// 10. DASHBOARD_HTML — SEÇÕES INTERNAS (CSS + HTML embutido)
// ===========================================================
// Dentro da string DASHBOARD_HTML (usada pelo ProviderDashboard)
// as seções de estilo/estrutura aparecem nesta ordem:
//   - Reset básico + fundo (tech-bg, room-blur, sparkle)
//   - Mapa animado de Belo Horizonte (roads, node-chip, labels)
//   - Chips eletrônicos decorativos (chip-trace, chip-spark)
//   - .panel (cartão principal dourado/glassmorphism)
//   - Cabeçalho: avatar, nome, selo, menu de perfil (profile-menu)
//   - Badge de avaliação (rating-badge / star3d)
//   - Selo da marca ShielD (brand-row/brand-logo)
//   - Estatísticas (stats-row, wallet-mini, eye-btn ocultar saldo)
//   - Toggle Online/Offline (toggle-wrap, status-dot)
//   - Notificações (notif-mini, notif-mini-count)
//   - Botões de ação (btn-row, action-btn, badge "Ativos")
//   - Cards de Demanda (demand-card, badges de natureza/urgência,
//     selo de qualidade baixo/médio/alto, botões Aceitar/Recusar)
//   - Card "Elite/Avançado" (vanta-black-card) com estilo dourado
//   - Lembrete de serviço agendado (reminder-card)
//   - Carteira e desempenho (bottom-grid, bars, earnings-row)
//   - Atividade recente (activity-card)
//   - Toast de feedback
//   - Overlay "offline" + botão "Ficar Online" (go-online-btn)
//   - Modal de negociação (modal-overlay/modal-box)
//   - Trilha de níveis (level-badge-lg, level-progress-track,
//     level-bench-row: Bronze/Prata/Ouro/Platina)
//   - Configurações (config-row + switch on/off)
//   - Chat com o cliente (chat-page, chat-bubble them/me/system)
//   - Página "Gerenciar Agenda" (agenda-page, agenda-tabs)
