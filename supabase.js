// Configuração da conexão com o Supabase utilizando as variáveis de ambiente
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://xnnhhhsxoaprgvfvqaak.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_QzFnirQmvpN4WVwxIBBVeg_zVMNC701';

// Inicializa o cliente do Supabase para uso global
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);