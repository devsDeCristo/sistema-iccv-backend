import { Global, Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/**
 * Global porque a sessão é única no processo: quem dispara (notícias, e o que
 * vier depois) precisa falar com a mesma instância, e não com uma cópia por
 * módulo.
 */
@Global()
@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
