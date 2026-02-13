// supabase-js via CDN
const { createClient } = supabase;
const sb = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

async function getMe() {
  const { data } = await sb.auth.getUser();
  return data.user || null;
}

async function requireAuth(redirectTo = "login.html") {
  const me = await getMe();
  if (!me) location.href = redirectTo;
  return me;
}

async function signOut() {
  await sb.auth.signOut();
  location.href = "login.html";
}

async function isAdmin() {
  const me = await getMe();
  if (!me) return false;
  const { data, error } = await sb.from("profiles").select("role").eq("id", me.id).single();
  if (error) return false;
  return data.role === "admin";
}

window.LT = { sb, getMe, requireAuth, signOut, isAdmin };
