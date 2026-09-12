import { Global, Module } from '@nestjs/common';
import { SecretCryptoService } from './secret-crypto.service';

/**
 * Global porque a chave é uma só e o serviço não guarda estado de requisição:
 * uma instância atende os gateways, a tela de configurações e o webhook sem
 * cada módulo ter que importar o de criptografia.
 */
@Global()
@Module({
  providers: [SecretCryptoService],
  exports: [SecretCryptoService],
})
export class CryptoModule {}
