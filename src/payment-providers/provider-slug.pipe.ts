import { NotFoundException, PipeTransform } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { providerDoSlug } from 'src/gateways/core/provider-slug';

/**
 * Converte o apelido da URL (`pagbank`, `mercadopago`) no valor do enum.
 *
 * Devolve 404 e não 400 para um apelido desconhecido: a resposta fica igual à
 * de uma casa que existe mas não está configurada, e a lista de integrações do
 * sistema não se descobre chutando a URL.
 */
export class ProviderSlugPipe
  implements PipeTransform<string, PaymentProvider>
{
  transform(value: string): PaymentProvider {
    const provider = providerDoSlug(value);

    if (!provider) {
      throw new NotFoundException('Integração não encontrada');
    }

    return provider;
  }
}
