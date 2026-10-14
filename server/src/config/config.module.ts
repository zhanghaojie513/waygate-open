import { Global, Module } from '@nestjs/common';
import { RelayConfigService } from './config.service';

@Global()
@Module({
  providers: [
    {
      provide: RelayConfigService,
      useFactory: (): RelayConfigService => new RelayConfigService(),
    },
  ],
  exports: [RelayConfigService],
})
export class ConfigModule {}
