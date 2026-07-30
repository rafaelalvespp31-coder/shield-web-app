// Configuração da conexão com o Supabase
const SUPABASE_URL = 'https://xnnhhhsxoaprgvfvqaak.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_QzFnirQmvpN4WVwxiBBVeg_zVMNC7O1';

// Inicializa o cliente do Supabase para uso global
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);