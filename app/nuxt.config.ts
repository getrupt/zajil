export default defineNuxtConfig({
  compatibilityDate: '2025-01-31',
  modules: ["@nuxtjs/supabase"],
  supabase: {
    redirect: false,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY
  },
  runtimeConfig: {
    public: {
      apiBase: "http://localhost:8787" // dev
    }
  }
});