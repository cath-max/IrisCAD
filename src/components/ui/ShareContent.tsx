import { Button } from '@/components/ui/button';
import { ClipboardCheck, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import {
  FacebookIcon,
  TwitterIcon,
  WhatsAppIcon,
} from '@/components/icons/CompanyIcons';
import {
  handleFacebookShare,
  handleTwitterShare,
  handleWhatsAppShare,
} from '@/utils/shareUtils';
import { cn } from '@/lib/utils';
import type React from 'react';

type ShareContentProps = {
  conversationId: string;
  privacy: 'public' | 'private';
  onPrivacyChange: (privacy: 'public' | 'private') => void;
};

export function ShareContent({
  conversationId,
  privacy,
  onPrivacyChange,
}: ShareContentProps) {
  const [justCopied, setJustCopied] = useState(false);

  const shareLink = `${window.location.origin}${import.meta.env.BASE_URL}share/${conversationId}`;
  const isPublic = privacy === 'public';

  const copyToClipboard = () => {
    navigator.clipboard.writeText(shareLink);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 2000);
  };

  const handlePublicClick = () => {
    onPrivacyChange('public');
    copyToClipboard();
  };

  return (
    <div className="iris-share-content flex w-full flex-col gap-6">
      <div className="flex flex-col gap-6">
        <div className="h-5 font-medium text-adam-neutral-100">
          Share public link to chat
        </div>
        <div className="flex items-center gap-3 text-xs text-adam-text-secondary">
          {isPublic ? (
            <div className="ml-1 h-1 w-1 rounded-full bg-[#64D557] outline outline-4 outline-[#79FF6B]/30" />
          ) : (
            <div className="h-3 w-3 rounded-full bg-[#FF392F] outline outline-2 outline-[#FF0000]/30" />
          )}
          {isPublic ? 'Anyone with the link can view' : 'Only you can view'}
        </div>

        <div
          className={cn(
            'flex w-full flex-col gap-6 overflow-hidden transition-all duration-300 ease-in-out',
            isPublic && 'h-44 opacity-100',
            !isPublic && 'h-0 opacity-0',
          )}
        >
          <div className="flex w-full items-center justify-between gap-4 rounded-full bg-adam-neutral-950 py-2 pl-6 pr-3">
            <span className="line-clamp-1 text-sm text-adam-neutral-100">
              {shareLink}
            </span>
            <button
              onClick={copyToClipboard}
              className="flex items-center gap-2 rounded-full border-2 border-black bg-white px-4 py-2 text-sm font-medium text-black focus:outline-none"
            >
              {justCopied ? (
                <ClipboardCheck className="h-4 w-4" />
              ) : (
                <CopyIcon className="h-4 w-4" />
              )}
              {justCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="grid w-full grid-cols-3 justify-between text-adam-neutral-300">
            <ShareButton
              label="WhatsApp"
              onClick={() => handleWhatsAppShare(conversationId)}
              icon={<WhatsAppIcon className="h-5 w-5" />}
            />
            <ShareButton
              label="X"
              onClick={() => handleTwitterShare(conversationId)}
              icon={<TwitterIcon className="h-5 w-5" />}
            />
            <ShareButton
              label="Facebook"
              onClick={() => handleFacebookShare(conversationId)}
              icon={<FacebookIcon className="h-5 w-5" />}
            />
          </div>
        </div>
      </div>

      {isPublic ? (
        <Button
          variant="destructive"
          onClick={() => onPrivacyChange('private')}
        >
          Make Private
        </Button>
      ) : (
        <Button variant="light" onClick={handlePublicClick}>
          Share
        </Button>
      )}
    </div>
  );
}

function ShareButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={onClick}
        className="iris-share-content__social flex h-10 w-10 items-center justify-center rounded-full bg-adam-neutral-950 text-adam-neutral-100"
      >
        {icon}
      </button>
      <span className="text-xs">{label}</span>
    </div>
  );
}
