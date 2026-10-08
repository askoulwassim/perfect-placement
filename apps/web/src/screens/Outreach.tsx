import { useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { DraftStatusChip, PrimaryButton, ToneChips } from '../components/controls';
import { ContactAvatar, OutreachBlock } from '../components/people';
import { ScreenHeader } from '../components/shell';
import { initials, TIER_LABEL, TONES } from '../lib/people';
import { go } from '../router';

export function OutreachScreen({ outreachId }: { outreachId: string }) {
  const act = useAct();
  const { showToast } = useApp();
  const res = useOp('outreach.get', { outreach_id: outreachId });
  const [tone, setTone] = useState<string | null>(null);

  if (!res.data) return <div className="screen" aria-busy={!res.error} />;
  const { outreach, contact, hook, proof, ask } = res.data;
  const inGmail = outreach.status !== 'drafted';

  const create = async () => {
    const o = await act('outreach.to_gmail', { outreach_id: outreach.id });
    if (o.status === 'ok') {
      showToast('Gmail draft');
      go({ screen: 'role', roleId: outreach.role_id });
    }
  };

  return (
    <div className="screen screen--outreach">
      <ScreenHeader
        title="Draft"
        onBack={() => go({ screen: 'people', roleId: outreach.role_id })}
        primary={<PrimaryButton label="Create Gmail draft" op="outreach.to_gmail" disabled={inGmail} onClick={() => void create()} />}
      />
      <div className="outreach-layout">
        <section className="panel recipient">
          <ContactAvatar initials={initials(contact.name)} tier={outreach.tier} size={64} />
          <span className="panel-title">{contact.name}</span>
          <span className="muted">{contact.headline}</span>
          <span className="eyebrow">{TIER_LABEL[outreach.tier]}</span>
          <DraftStatusChip status={outreach.status} />
        </section>
        <section className="outreach-body">
          <ToneChips
            tones={TONES.map((x) => ({ id: x.tier, label: x.label }))}
            recommended={outreach.tier}
            selected={tone ?? outreach.tier}
            onSelect={setTone}
          />
          <OutreachBlock label="Hook" text={hook} />
          <OutreachBlock label="Proof" text={proof} />
          <OutreachBlock label="Ask" text={ask} />
        </section>
      </div>
    </div>
  );
}
