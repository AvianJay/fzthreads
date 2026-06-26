interface ImageProps {
  url: string;
}

interface VideoProps {
  url: string;
  type?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
}

interface ContentProps {
  description: string;
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
  authorUrl?: string;
  authorIcon?: string;
  footerName?: string;
  footerIcon?: string;
  quotedPost?: QuotedPostProps;
  userAgent: string;
}

interface DataProps {
  type: string;
  content: ContentProps;
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
  caption: string;
  quoted: boolean;
}
