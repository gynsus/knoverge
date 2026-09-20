import type { MemberSummary, MembershipRole, WorkspaceSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { useAuth } from '../auth/use-auth.ts';
import { WORKSPACE_KEY, useWorkspaceContext } from '../auth/use-workspace.ts';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableActions,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

// Its own key space. ['workspace', 'members'] shares one with the context's
// ['workspace', <id>], so the two would invalidate each other by accident.
const MEMBERS_KEY = ['workspace-members'] as const;
const ROLES: MembershipRole[] = ['owner', 'admin', 'reviewer', 'viewer'];

function MemberRow({
  member,
  onChanged,
  isSelf,
}: {
  member: MemberSummary;
  onChanged: () => Promise<void>;
  isSelf: boolean;
}) {
  const { t, i18n } = useTranslation();
  // A role change is held here until it is applied. Two reasons: the select is
  // controlled by server data, so without it the control visibly reverts to the
  // old role while the change is in flight; and changing what somebody may do
  // should not happen on a stray keystroke over a dropdown.
  const [pendingRole, setPendingRole] = useState<MembershipRole | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const update = useMutation({
    mutationFn: (role: MembershipRole) =>
      adminApi.workspace.updateMember({ user_id: member.user_id, role }),
    onSuccess: async () => {
      await onChanged();
      setPendingRole(null);
    },
  });
  const remove = useMutation({
    mutationFn: () => adminApi.workspace.removeMember(member.user_id),
    onSuccess: onChanged,
  });
  const role = pendingRole ?? member.role;
  return (
    <TableRow>
      <TableCell label={t('workspace.person')}>
        <span>{member.display_name}</span> <code>{member.email}</code>
      </TableCell>
      <TableCell label={t('workspace.role')}>
        <Select
          value={role}
          aria-label={t('workspace.role_of', { name: member.display_name })}
          onChange={(e) => setPendingRole(e.target.value as MembershipRole)}
          disabled={update.isPending || isSelf}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </Select>
        {pendingRole !== null && pendingRole !== member.role && (
          <TableActions>
            <Button
              type="button"
              onClick={() => update.mutate(pendingRole)}
              disabled={update.isPending}
            >
              {update.isPending ? t('common.working') : t('workspace.apply_role')}
            </Button>
            <Button variant="outline" type="button" onClick={() => setPendingRole(null)}>
              {t('common.cancel')}
            </Button>
          </TableActions>
        )}
      </TableCell>
      <TableCell label={t('workspace.last_seen')}>
        {member.last_login_at
          ? new Date(member.last_login_at).toLocaleDateString(i18n.language)
          : t('workspace.never_signed_in')}
      </TableCell>
      <TableCell label={t('common.actions')}>
        {isSelf ? (
          <span>
            <small>{t('workspace.this_is_you')}</small>
          </span>
        ) : confirmingRemoval ? (
          <TableActions>
            <span className="text-sm">
              {t('workspace.confirm_remove', { name: member.display_name })}
            </span>
            <Button
              variant="destructive"
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? t('common.working') : t('workspace.confirm')}
            </Button>
            <Button variant="outline" type="button" onClick={() => setConfirmingRemoval(false)}>
              {t('common.cancel')}
            </Button>
          </TableActions>
        ) : (
          <Button type="button" onClick={() => setConfirmingRemoval(true)}>
            {t('workspace.remove')}
          </Button>
        )}
        <ErrorNotice error={update.error ?? remove.error} />
      </TableCell>
    </TableRow>
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
    <form onSubmit={submit} className="grid gap-4">
      <FieldSet disabled={!canAdminister || save.isPending}>
        <Field label={t('workspace.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <Field label={t('workspace.description')}>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
        </Field>
        <Field label={t('workspace.default_language')} hint={t('workspace.default_language_hint')}>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">{t('language.en')}</option>
            <option value="ru">{t('language.ru')}</option>
          </Select>
        </Field>
        <p>
          <small>
            {t('workspace.identifier')}: <code>{workspace.slug}</code>
          </small>
        </p>
      </FieldSet>
      <ErrorNotice error={save.error} />
      {saved && <p role="status">{t('workspace.saved')}</p>}
      {canAdminister && (
        <Button type="submit" disabled={save.isPending} className="justify-self-start">
          {save.isPending ? t('common.working') : t('workspace.save')}
        </Button>
      )}
    </form>
  );
}

export function WorkspacePage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const auth = useAuth();
  const myUserId = auth.state.kind === 'authenticated' ? auth.state.me.user.id : undefined;
  const [email, setEmail] = useState('');
  const [memberName, setMemberName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<MembershipRole>('reviewer');

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

  // The server gates on the permission, so the interface asks the same
  // question. Deriving it from the role showed a disabled form to a reviewer
  // who had been granted workspace administration explicitly.
  const canAdminister = workspaces.can('workspace.admin');

  return (
    <>
      <Card aria-labelledby="workspace-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="workspace-title">{t('workspace.title')}</CardTitle>
        {/* The same request the shell already made, read from the context
            rather than fetched again under a second key. */}
        {workspaces.isPending && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={workspaces.error} />
        {workspaces.workspace && (
          <WorkspaceSettingsForm
            key={workspaces.workspace.id}
            workspace={workspaces.workspace}
            canAdminister={canAdminister}
          />
        )}
      </Card>

      {canAdminister && (
        <>
          <Card aria-labelledby="members-title" className="grid gap-3 p-4 sm:p-6">
            <CardTitle id="members-title">{t('workspace.members')}</CardTitle>
            {members.isPending && <p role="status">{t('common.loading')}</p>}
            {members.isError && <ErrorNotice error={members.error} />}
            {members.data && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('workspace.person')}</TableHead>
                    <TableHead>{t('workspace.role')}</TableHead>
                    <TableHead>{t('workspace.last_seen')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.data.members.map((member) => (
                    <MemberRow
                      key={member.user_id}
                      member={member}
                      onChanged={refreshMembers}
                      // Changing your own role and removing yourself are both
                      // refused by the server, so the controls are not offered.
                      isSelf={member.user_id === myUserId}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card aria-labelledby="add-member-title" className="grid gap-3 p-4 sm:p-6">
            <CardTitle id="add-member-title">{t('workspace.add_member')}</CardTitle>
            <p>{t('workspace.add_member_intro')}</p>
            <form onSubmit={submitMember} className="grid gap-4">
              <FieldSet disabled={addMember.isPending}>
                <Field label={t('fields.email')}>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>
                <Field label={t('fields.display_name')} hint={t('workspace.display_name_hint')}>
                  <Input value={memberName} onChange={(e) => setMemberName(e.target.value)} />
                </Field>
                <Field
                  label={t('workspace.initial_password')}
                  hint={t('workspace.initial_password_hint')}
                >
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label={t('workspace.role')}>
                  <Select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`roles.${r}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FieldSet>
              <ErrorNotice error={addMember.error} />
              <Button type="submit" disabled={addMember.isPending} className="justify-self-start">
                {addMember.isPending ? t('common.working') : t('workspace.add')}
              </Button>
            </form>
          </Card>
        </>
      )}
    </>
  );
}
