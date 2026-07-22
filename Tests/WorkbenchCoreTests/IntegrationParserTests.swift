import Testing

@testable import WorkbenchCore

@Suite("Local integration parsers")
struct IntegrationParserTests {
  @Test("parses work-cli process rows with and without URLs")
  func parsesWorkCLIStatus() {
    let output = """
      status   project/workspace   command   runner   handle   url
      running  shop/feature-auth   web       tmux     web-12   http://web-feature-auth-shop.localhost
      stopped  shop/feature-auth   worker    tmux     worker-9
      """

    let commands = WorkCLIParser.parseStatus(output)

    #expect(commands.count == 2)
    #expect(commands[0].project == "shop")
    #expect(commands[0].workspace == "feature-auth")
    #expect(commands[0].url == "http://web-feature-auth-shop.localhost")
    #expect(commands[1].url == nil)
  }

  @Test("extracts only public Convex deployment metadata")
  func parsesConvexEnvironment() {
    let environment = """
      CONVEX_DEPLOYMENT=dev:happy-otter-123
      CONVEX_URL=https://happy-otter-123.convex.cloud
      CONVEX_DEPLOY_KEY=secret-that-must-not-leak
      """

    let deployment = EnvironmentFileParser.convexDeployment(from: environment, source: ".env.local")

    #expect(deployment?.kind == "dev")
    #expect(deployment?.name == "happy-otter-123")
    #expect(deployment?.url == "https://happy-otter-123.convex.cloud")
    #expect(String(describing: deployment).contains("secret-that-must-not-leak") == false)
  }
}
