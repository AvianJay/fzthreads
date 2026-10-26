interface ImageProps {
  url: string;
  position?: number;
  spoiler?: boolean;
  description?: string;
}

interface VideoProps extends ImageProps {
  type?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
}

interface ProfileLinkProps {
  title: string;
  url: string;
}

interface ProfileProps {
  displayName: string;
  followerCount?: number;
  publicViewCount?: number;
  instagramUrl?: string;
  isVerified?: boolean;
  isPrivate?: boolean;
  isFederated?: boolean;
  // Undefined means unavailable; an empty array means no profile links.
  links?: ProfileLinkProps[];
}

interface PollOptionProps {
  title: string;
  votesCount?: number;
}

interface PollProps {
  id?: string;
  expiresAt?: string;
  expired?: boolean;
  options: PollOptionProps[];
  votesCount?: number;
}

interface InlineEmojiProps {
  key: string;
  url: string;
  // UTF-16 offsets in the stored caption, including upstream spoiler markers.
  offset: number;
  length: number;
}

interface EmojiSourceProps {
  key: string;
  url: string;
  circle?: boolean;
}

interface DiscordEmojiProps {
  id: string;
  name: string;
  animated: boolean;
}

interface ContentProps {
  description: string;
  caption?: string;
  replyToUsername?: string;
  topicTag?: string;
  textAttachment?: string;
  emojis?: InlineEmojiProps[];
  textAttachmentEmojis?: InlineEmojiProps[];
  avatarEmoji?: EmojiSourceProps;
  discordEmojis?: Record<string, DiscordEmojiProps>;
  title: string;
  images: ImageProps[];
  username: string;
  post?: string;
  postId?: string;
  activityUrl?: string;
  activityStatusId?: string;
  publishedTime?: string;
  imageType: string;
  video: VideoProps[];
  oembedStat: string;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  sendCount?: number;
  authorName?: string;
  authorDisplayName?: string;
  isVerified?: boolean;
  isFederated?: boolean;
  authorUrl?: string;
  authorIcon?: string;
  footerName?: string;
  footerIcon?: string;
  quotedPost?: QuotedPostProps;
  poll?: PollProps;
  profile?: ProfileProps;
  userAgent: string;
}

interface DataProps {
  type: string;
  content: ContentProps;
  host?: string;
}

interface OembedPostProps {
  author_name: string;
  author_url: string;
  provider_name: string;
  provider_url: string;
  title: string;
  type: string;
  version: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  author_icon?: string;
  provider_icon?: string;
}

interface QuotedPostProps {
  username: string;
  post?: string;
  caption: string;
  quoted: boolean;
  poll?: PollProps;
  emojis?: InlineEmojiProps[];
}
