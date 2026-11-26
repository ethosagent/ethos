// The cookie-auth route modules `assembleWebApi` always mounts (split out of index.ts):
// downloads/uploads, backups and personality avatars. Each needs a service the assembler
// constructs, so they are declared through the same reviewable RouteModule seam as the
// caller-supplied ones, and mount BEFORE the static `/*` catch-all.

import { backupRoutes } from '../routes/backup';
import { documentsRoutes } from '../routes/documents';
import { personalityAvatarRoutes } from '../routes/personality-avatar';
import type { RouteModule } from '../routes/route-module';
import type { BackupService } from '../services/backup.service';
import type { DocumentsService } from '../services/documents.service';
import type { PersonalitiesService } from '../services/personalities.service';

export function builtinRouteModules(deps: {
  documents: DocumentsService;
  backup: BackupService;
  personalities: PersonalitiesService;
}): RouteModule[] {
  return [
    {
      basePath: '/documents',
      router: documentsRoutes({ documents: deps.documents }),
      auth: 'cookie',
      description:
        'Streams a file out of a personality workdir, and accepts a raw-body upload ' +
        'into one. Cookie-only: an `<a download>` navigation carries `ethos_auth`, ' +
        'but a Bearer header cannot be attached to one.',
    },
    {
      basePath: '/backup',
      router: backupRoutes({ backup: deps.backup }),
      auth: 'cookie',
      description:
        'Streams one `~/.ethos` backup archive out of the backup directory. Cookie-only, ' +
        'same posture as `/documents`: an `<a download>` navigation carries `ethos_auth`, ' +
        'but a Bearer header cannot be attached to one — so desktop remote mode cannot ' +
        'use it, and `backup.status` says so via `downloadAvailable`.',
    },
    {
      basePath: '/api/personalities',
      router: personalityAvatarRoutes({ personalities: deps.personalities }),
      auth: 'cookie',
      description:
        'Upload/serve/delete a personality avatar image. Cookie-only, same posture as ' +
        '`/documents`: personality-mutating writes are cookie-only everywhere else in ' +
        'this app too (see dual-auth.ts SCOPE_MAP), and `<img src>` cannot carry a ' +
        'Bearer header regardless.',
    },
  ];
}
