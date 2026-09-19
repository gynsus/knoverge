import type { MemberSummary, MembershipRole, WorkspaceSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Field } from '../components/Field.tsx';

const WORKSPACE_KEY = ['workspace'] as const;
const MEMBERS_KEY = ['workspace', 'members'] as const;
const ROLES: MembershipRole[] = ['owner', 'admin', 'reviewer', 'viewer'];

function MemberRow({
  member,
  onChanged,
}: {
  member: MemberSummary;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const update = useMutation({
    mutationFn: (role: MembershipRole) =>
      adminApi.workspace.updateMember({ user_id: member.user_id, role }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => adminApi.workspace.removeMember(member.user_id),
    onSuccess: onChanged,
  });
  return (
    <tr>
      <td>
        <span>{member.display_name}</span> <code>{member.email}</code>
      </td>
      <td>
        <select
          value={member.role}
          aria-label={t('workspace.role_of', { name: member.display_name })}
          onChange={(e) => update.mutate(e.target.value as MembershipRole)}
          disabled={update.isPending}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`roles.${role}`)}
            </option>
          ))}
        </select>
      </td>
      <td>
        {member.last_login_at
          ? new Date(member.last_login_at).toLocaleDateString()
          : t('workspace.never_signed_in')}
      </td>
      <td>
        <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
          {t('workspace.remove')}
        </button>
        <ErrorNotice error={update.error ?? remove.error} />
      </td>
    </tr>
  );
}

function WorkspaceSettingsForm({
  workspace,
  canAdminister,
}: {
  workspace: WorkspaceSummary;
  canAdminister: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  // Initialised from the loaded workspace; the key on this component resets the
  // fields when a different workspace is shown.
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? '');
  const [language, setLanguage] = useState<string>(workspace.default_language);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      adminApi.workspace.update({
        name,
        description: description || null,
        default_language: language,
      }),
    onSuccess: async () => {
      setSaved(true);
      await client.invalidateQueries({ queryKey: WORKSPACE_KEY });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate();
  };

  return (
    <form onSubmit={submit}>
      <fieldset disabled={!canAdminister || save.isPending}>
        <Field label={t('workspace.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label={t('workspace.description')}>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
        </Field>
        <Field label={t('workspace.default_language')} hint={t('workspace.default_language_hint')}>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">{t('language.en')}</option>
            <option value="ru">{t('language.ru')}</option>
          </select>
        </Field>
        <p>
          <small>
            {t('workspace.identifier')}: <code>{workspace.slug}</code>
          </small>
        </p>
      </fieldset>
      <ErrorNotice error={save.error} />
      {saved && <p role="status">{t('workspace.saved')}</p>}
      {canAdminister && (
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.working') : t('workspace.save')}
        </button>
      )}
    </form>
  );
}

export function WorkspacePage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [memberName, setMemberName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<MembershipRole>('reviewer');

  const workspace = useQuery({
    queryKey: WORKSPACE_KEY,
    queryFn: ({ signal }) => adminApi.workspace.get(signal),
  });
  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: ({ signal }) => adminApi.workspace.members(signal),
    retry: false,
  });

  const refreshMembers = async () => {
    await client.invalidateQueries({ queryKey: MEMBERS_KEY });
  };

  const addMember = useMutation({
    mutationFn: () =>
      adminApi.workspace.addMember({
        email,
        role,
        ...(memberName ? { display_name: memberName } : {}),
        ...(password ? { initial_password: password } : {}),
      }),
    onSuccess: async () => {
      setEmail('');
      setMemberName('');
      setPassword('');
      await refreshMembers();
    },
  });

  const submitMember = (event: FormEvent) => {
    event.preventDefault();
    addMember.mutate();
  };

  const canAdminister =
    (workspace.data?.workspace.role ?? 'viewer') === 'owner' ||
    workspace.data?.workspace.role === 'admin';

  return (
    <>
      <section className="card" aria-labelledby="workspace-title">
        <h2 id="workspace-title">{t('workspace.title')}</h2>
        {workspace.isPending && <p role="status">{t('common.loading')}</p>}
        {workspace.isError && <ErrorNotice error={workspace.error} />}
        {workspace.data && (
          <WorkspaceSettingsForm
            key={workspace.data.workspace.id}
            workspace={workspace.data.workspace}
            canAdminister={canAdminister}
          />
        )}
      </section>

      {canAdminister && (
        <>
          <section className="card" aria-labelledby="members-title">
            <h2 id="members-title">{t('workspace.members')}</h2>
            {members.isPending && <p role="status">{t('common.loading')}</p>}
            {members.isError && <ErrorNotice error={members.error} />}
            {members.data && (
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('workspace.person')}</th>
                    <th scope="col">{t('workspace.role')}</th>
                    <th scope="col">{t('workspace.last_seen')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {members.data.members.map((member) => (
                    <MemberRow key={member.user_id} member={member} onChanged={refreshMembers} />
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card" aria-labelledby="add-member-title">
            <h3 id="add-member-title">{t('workspace.add_member')}</h3>
            <p>{t('workspace.add_member_intro')}</p>
            <form onSubmit={submitMember}>
              <fieldset disabled={addMember.isPending}>
                <Field label={t('fields.email')}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>
                <Field label={t('fields.display_name')} hint={t('workspace.display_name_hint')}>
                  <input value={memberName} onChange={(e) => setMemberName(e.target.value)} />
                </Field>
                <Field
                  label={t('workspace.initial_password')}
                  hint={t('workspace.initial_password_hint')}
                >
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label={t('workspace.role')}>
                  <select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`roles.${r}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </fieldset>
              <ErrorNotice error={addMember.error} />
              <button type="submit" disabled={addMember.isPending}>
                {addMember.isPending ? t('common.working') : t('workspace.add')}
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
