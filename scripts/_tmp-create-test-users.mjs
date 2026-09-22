import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const users = [
  { email: 'walkthrough-admin@synthtestco.com', password: 'WalkthroughTest123!' },
  { email: 'walkthrough-student@synthtestco.com', password: 'WalkthroughTest123!' },
];

for (const u of users) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: u.email,
    password: u.password,
    email_confirm: true,
  });
  if (error) {
    console.error(`Failed to create ${u.email}:`, error.message);
  } else {
    console.log(`Created ${u.email} -> ${data.user.id}`);
  }
}
