import { Global, Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/**
 * Global porque as sessões vivem no processo: quem dispara (notícias, e o que
 * vier depois) precisa falar com a mesma instância do registro, e não com uma
 * cópia por módulo — uma cópia teria o próprio mapa, e o socket pareado numa
 * seria invisível na outra.
 */
@Global()
@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
